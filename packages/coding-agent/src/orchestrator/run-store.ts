/**
 * Persistent Swarm Run Store and in-memory Live Run Registry.
 *
 * Two responsibilities:
 * 1. **Live Run Registry**: tracks active or recently completed swarm runs in
 *    the current process so `/swarm board` or status commands can attach to a
 *    live worker board snapshot, cancel individual workers, or stop the run.
 * 2. **On-Disk Run Store (`SwarmRunStore`)**: persists run metadata, per-task
 *    outcomes, and per-task worker/verification logs under
 *    `<agentDir>/swarms/<planId>/`, supporting resume plans that strip
 *    already-completed tasks and dependencies.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkerPane } from "@marsai-org/tui/apps/orchestrator-board";
import { getAgentDir, isEnoent, isRecord } from "@marsai-org/utils";
import type { EngineReport, TaskOutcomeRecord } from "./engine";
import type { OrchestratorPlan, TaskState, UsageTotals, WorkerUsage } from "./types";
import type { VerificationResult } from "./verifier";

/** In-process handle to a running (or recently finished) swarm orchestration. */
export interface LiveSwarmRun {
	readonly planId: string;
	readonly goal: string;
	readonly startedAt: number;
	readonly getSnapshot: () => readonly WorkerPane[];
	readonly cancelWorker?: (workerId: string) => void;
	readonly stopAll: () => void;
	readonly isActive: () => boolean;
}

const liveRuns = new Map<string, LiveSwarmRun>();

/**
 * Register a live swarm run in the in-memory registry.
 * Returns an disposer that removes the run when called.
 */
export function registerLiveSwarmRun(run: LiveSwarmRun): () => void {
	if (liveRuns.has(run.planId)) {
		liveRuns.delete(run.planId);
	}
	liveRuns.set(run.planId, run);
	return () => {
		if (liveRuns.get(run.planId) === run) {
			liveRuns.delete(run.planId);
		}
	};
}

/**
 * Look up a live swarm run by `planId`, or return the currently active run
 * (falling back to the most recently registered run when none is active).
 */
export function getActiveSwarmRun(planId?: string): LiveSwarmRun | undefined {
	if (planId !== undefined) {
		return liveRuns.get(planId);
	}
	const all = [...liveRuns.values()];
	for (let i = all.length - 1; i >= 0; i--) {
		const candidate = all[i];
		if (candidate?.isActive()) return candidate;
	}
	return all[all.length - 1];
}

/** List all registered live runs in the current process, newest first. */
export function listLiveSwarmRuns(): readonly LiveSwarmRun[] {
	return [...liveRuns.values()].reverse();
}

/** Clear all entries from the in-memory live run registry. */
export function clearLiveSwarmRuns(): void {
	liveRuns.clear();
}

export type SwarmRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Persisted record for a single task within a swarm run. */
export interface PersistedTaskRecord {
	readonly taskId: string;
	readonly title: string;
	readonly state: TaskState;
	readonly workerId?: string;
	readonly exitCode?: number;
	readonly output?: string;
	readonly error?: string;
	readonly branchName?: string;
	readonly patchPath?: string;
	readonly baseSha?: string;
	readonly hasChanges?: boolean;
	readonly mergeSummary?: string;
	readonly verification?: VerificationResult;
	readonly usage?: WorkerUsage;
	readonly logFile?: string;
}

/** Full persisted state written to `<baseDir>/<planId>/state.json`. */
export interface PersistedSwarmRun {
	readonly version: 1;
	readonly planId: string;
	readonly goal: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly status: SwarmRunStatus;
	readonly stoppedReason?: string;
	readonly plan: OrchestratorPlan;
	readonly tasks: Readonly<Record<string, PersistedTaskRecord>>;
	readonly usage: UsageTotals;
}

/** Lightweight summary returned by `SwarmRunStore.listRuns()`. */
export interface PersistedSwarmRunSummary {
	readonly planId: string;
	readonly goal: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly status: SwarmRunStatus;
	readonly stoppedReason?: string;
	readonly totalTasks: number;
	readonly completedTasks: number;
	readonly failedTasks: number;
}

export interface SwarmRunStoreOptions {
	/** Root directory for persisted runs. Defaults to `<agentDir>/swarms`. */
	readonly baseDir?: string;
	/** Clock injection for deterministic timestamps in tests. */
	readonly now?: () => number;
}

const PATH_TRAVERSAL_PATTERN = /[/\\]|\.\./;

function validateSafeId(id: string, label: string): void {
	if (!id || id.trim() === "" || id === "." || PATH_TRAVERSAL_PATTERN.test(id)) {
		throw new Error(`Invalid ${label} "${id}": path traversal or separator characters are not allowed`);
	}
}

function emptyUsage(): UsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		requests: 0,
		wallClockMs: 0,
	};
}

function deriveRunStatus(
	plan: OrchestratorPlan,
	report: EngineReport,
	tasks: Readonly<Record<string, PersistedTaskRecord>>,
): SwarmRunStatus {
	const records = Object.values(tasks);
	const allCompleted =
		plan.tasks.length > 0 &&
		plan.tasks.every(task => tasks[task.id]?.state === "completed") &&
		records.every(record => record.state === "completed");

	if (allCompleted && !report.stoppedReason) {
		return "completed";
	}
	if (records.some(record => record.state === "failed")) {
		return "failed";
	}
	if (report.stoppedReason?.toLowerCase().includes("cancel") || records.some(record => record.state === "cancelled")) {
		return "cancelled";
	}
	if (report.stoppedReason) {
		return "failed";
	}
	return allCompleted ? "completed" : "failed";
}

function formatTaskLog(taskId: string, record: TaskOutcomeRecord): string {
	const sections: string[] = [];
	sections.push(`# Task ${taskId} (${record.state})`);
	if (record.workerId) sections.push(`worker: ${record.workerId}`);
	if (record.outcome?.exitCode !== undefined) sections.push(`exitCode: ${record.outcome.exitCode}`);
	if (record.outcome?.changes?.branchName) sections.push(`branch: ${record.outcome.changes.branchName}`);
	if (record.error) sections.push(`error: ${record.error}`);
	if (record.outcome?.error && record.outcome.error !== record.error) {
		sections.push(`workerError: ${record.outcome.error}`);
	}
	if (record.outcome?.output) {
		sections.push("", "## Output", record.outcome.output);
	}
	if (record.verification && record.verification.checks.length > 0) {
		sections.push("", "## Verification");
		for (const check of record.verification.checks) {
			const status = check.ok ? "PASS" : "FAIL";
			const detail = check.failure
				? ` (${check.failure})`
				: check.exitCode !== null
					? ` (exit ${check.exitCode})`
					: "";
			sections.push(`### [${status}] ${check.id}: ${check.command}${detail}`);
			if (check.output) sections.push(check.output);
		}
	}
	return `${sections.join("\n")}\n`;
}

/**
 * Build a resume `OrchestratorPlan` containing only tasks from `run` whose
 * persisted state is NOT `"completed"`, stripping already-completed task IDs
 * from each remaining task's `dependencies`.
 *
 * Returns `null` when every task in the plan has already completed.
 */
export function buildResumePlan(run: PersistedSwarmRun): OrchestratorPlan | null {
	const completedIds = new Set<string>();
	for (const [taskId, record] of Object.entries(run.tasks)) {
		if (record.state === "completed") {
			completedIds.add(taskId);
		}
	}

	const remainingTasks = run.plan.tasks
		.filter(task => !completedIds.has(task.id))
		.map(task => ({
			...task,
			dependencies: task.dependencies.filter(dep => !completedIds.has(dep)),
		}));

	if (remainingTasks.length === 0) {
		return null;
	}

	return {
		...run.plan,
		tasks: remainingTasks,
	};
}

export class SwarmRunStore {
	readonly #baseDir: string;
	readonly #now: () => number;

	constructor(options: SwarmRunStoreOptions | string = {}) {
		if (typeof options === "string") {
			this.#baseDir = options;
			this.#now = Date.now;
		} else {
			this.#baseDir = options.baseDir ?? path.join(getAgentDir(), "swarms");
			this.#now = options.now ?? Date.now;
		}
	}

	get baseDir(): string {
		return this.#baseDir;
	}

	#runDir(planId: string): string {
		validateSafeId(planId, "planId");
		return path.join(this.#baseDir, planId);
	}

	#statePath(planId: string): string {
		return path.join(this.#runDir(planId), "state.json");
	}

	#taskLogPath(planId: string, taskId: string): string {
		validateSafeId(taskId, "taskId");
		return path.join(this.#runDir(planId), "logs", `${taskId}.log`);
	}

	/** Persist initial run metadata and task records when a plan starts. */
	async saveRunStart(plan: OrchestratorPlan, cwd: string): Promise<void> {
		const statePath = this.#statePath(plan.id);
		const now = this.#now();
		const tasks: Record<string, PersistedTaskRecord> = {};
		for (const task of plan.tasks) {
			validateSafeId(task.id, "taskId");
			tasks[task.id] = {
				taskId: task.id,
				title: task.title,
				state: "pending",
			};
		}

		const persisted: PersistedSwarmRun = {
			version: 1,
			planId: plan.id,
			goal: plan.goal,
			cwd,
			createdAt: now,
			updatedAt: now,
			status: "running",
			plan,
			tasks,
			usage: emptyUsage(),
		};

		await Bun.write(statePath, JSON.stringify(persisted, null, "\t"));
	}

	/** Persist final task outcomes, usage, status, and per-task log files when a run settles. */
	async saveRunComplete(plan: OrchestratorPlan, report: EngineReport, cwd: string): Promise<void> {
		const statePath = this.#statePath(plan.id);
		const existing = await this.loadRun(plan.id);
		const now = this.#now();
		const createdAt = existing?.createdAt ?? now;

		const titleByTaskId = new Map(plan.tasks.map(task => [task.id, task.title]));
		const tasks: Record<string, PersistedTaskRecord> = {};

		for (const task of plan.tasks) {
			validateSafeId(task.id, "taskId");
			const record = report.outcomes.get(task.id);
			if (!record) {
				tasks[task.id] = existing?.tasks[task.id] ?? {
					taskId: task.id,
					title: task.title,
					state: "pending",
				};
				continue;
			}
			const logRelPath = path.join("logs", `${task.id}.log`);
			await Bun.write(this.#taskLogPath(plan.id, task.id), formatTaskLog(task.id, record));
			tasks[task.id] = this.#toPersistedTask(task.id, task.title, record, logRelPath);
		}

		for (const [taskId, record] of report.outcomes) {
			if (tasks[taskId]) continue;
			validateSafeId(taskId, "taskId");
			const logRelPath = path.join("logs", `${taskId}.log`);
			await Bun.write(this.#taskLogPath(plan.id, taskId), formatTaskLog(taskId, record));
			tasks[taskId] = this.#toPersistedTask(taskId, titleByTaskId.get(taskId) ?? taskId, record, logRelPath);
		}

		const status = deriveRunStatus(plan, report, tasks);
		const persisted: PersistedSwarmRun = {
			version: 1,
			planId: plan.id,
			goal: plan.goal,
			cwd,
			createdAt,
			updatedAt: now,
			status,
			...(report.stoppedReason === undefined ? {} : { stoppedReason: report.stoppedReason }),
			plan,
			tasks,
			usage: report.usage,
		};

		await Bun.write(statePath, JSON.stringify(persisted, null, "\t"));
	}

	#toPersistedTask(taskId: string, title: string, record: TaskOutcomeRecord, logFile: string): PersistedTaskRecord {
		const changes = record.outcome?.changes;
		const error = record.error ?? record.outcome?.error;
		return {
			taskId,
			title,
			state: record.state,
			...(record.workerId === undefined ? {} : { workerId: record.workerId }),
			...(record.outcome?.exitCode === undefined ? {} : { exitCode: record.outcome.exitCode }),
			...(record.outcome?.output === undefined ? {} : { output: record.outcome.output }),
			...(error === undefined ? {} : { error }),
			...(changes?.branchName === undefined ? {} : { branchName: changes.branchName }),
			...(changes?.patchPath === undefined ? {} : { patchPath: changes.patchPath }),
			...(changes?.baseSha === undefined ? {} : { baseSha: changes.baseSha }),
			...(changes?.hasChanges === undefined ? {} : { hasChanges: changes.hasChanges }),
			...(changes?.mergeSummary === undefined ? {} : { mergeSummary: changes.mergeSummary }),
			...(record.verification === undefined ? {} : { verification: record.verification }),
			...(record.outcome?.usage === undefined ? {} : { usage: record.outcome.usage }),
			logFile,
		};
	}

	/** Read a task's persisted log file, or `null` if it does not exist. */
	async readTaskLog(planId: string, taskId: string): Promise<string | null> {
		const logPath = this.#taskLogPath(planId, taskId);
		try {
			return await Bun.file(logPath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	/** Load a persisted swarm run by `planId`, returning `null` if not found. */
	async loadRun(planId: string): Promise<PersistedSwarmRun | null> {
		const statePath = this.#statePath(planId);
		try {
			const data: unknown = await Bun.file(statePath).json();
			if (!isRecord(data) || data.version !== 1 || typeof data.planId !== "string") {
				return null;
			}
			return data as unknown as PersistedSwarmRun;
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	/** List persisted swarm runs sorted newest first (`updatedAt` descending). */
	async listRuns(limit?: number): Promise<PersistedSwarmRunSummary[]> {
		let entries;
		try {
			entries = await fs.readdir(this.#baseDir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}

		const summaries: PersistedSwarmRunSummary[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (PATH_TRAVERSAL_PATTERN.test(entry.name)) continue;
			let run: PersistedSwarmRun | null = null;
			try {
				run = await this.loadRun(entry.name);
			} catch {
				continue;
			}
			if (!run) continue;

			const records = Object.values(run.tasks);
			const totalTasks = run.plan.tasks.length || records.length;
			const completedTasks = records.filter(record => record.state === "completed").length;
			const failedTasks = records.filter(record => record.state === "failed").length;

			summaries.push({
				planId: run.planId,
				goal: run.goal,
				cwd: run.cwd,
				createdAt: run.createdAt,
				updatedAt: run.updatedAt,
				status: run.status,
				...(run.stoppedReason === undefined ? {} : { stoppedReason: run.stoppedReason }),
				totalTasks,
				completedTasks,
				failedTasks,
			});
		}

		summaries.sort(
			(a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.planId.localeCompare(a.planId),
		);

		if (limit !== undefined && limit >= 0) {
			return summaries.slice(0, limit);
		}
		return summaries;
	}

	/**
	 * Build a resume `OrchestratorPlan` containing only tasks that did not
	 * complete in `run`, stripping already-completed task IDs from their
	 * `dependencies`. Returns `null` if all tasks already completed.
	 */
	buildResumePlan(run: PersistedSwarmRun): OrchestratorPlan | null {
		return buildResumePlan(run);
	}
}
