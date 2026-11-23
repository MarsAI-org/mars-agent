/**
 * `orchestrate` tool: run a task DAG through the multi-agent orchestrator.
 *
 * The orchestrator engine existed as a complete, tested module that nothing in
 * the application ever constructed. This tool is its production entry point: it
 * turns a caller-supplied plan into an `OrchestratorPlan`, runs it through the
 * native worker runner, and reports the per-task outcome.
 *
 * It is gated on `orchestrator.enabled`. With the setting off the tool is not
 * registered at all, so a default install behaves exactly as it did before.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 4, 5, 8.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@marsai-org/agent-core";
import { type } from "@marsai-org/omptype";
import type { WorkerPane } from "@marsai-org/tui/apps/orchestrator-board";
import {
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@marsai-org/tui/render/render-utils";
import { isRecord, logger, prompt } from "@marsai-org/utils";
import { isAndroid } from "@marsai-org/utils/platform";

import orchestrateDescription from "../prompts/tools/orchestrate.md" with { type: "text" };
import { BoardModel } from "../orchestrator/board-model";
import { createNativeOrchestrationEngine } from "../orchestrator/native-runner";
import { countModules, DEFAULT_ROUTER_THRESHOLDS, decideFanOut } from "../orchestrator/router";
import { registerLiveSwarmRun, SwarmRunStore } from "../orchestrator/run-store";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMode,
	cfgOrchestratorTouchPoints,
	resolveOrchestratorLimits,
} from "../orchestrator/settings";
import type { OrchestratorPlan, OrchestratorTask, WorkerSpec } from "../orchestrator/types";
import type { ToolSession } from "../sdk";
import { discoverAgents, getAgent } from "../task/discovery";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import type { AgentDefinition } from "../task/types";
import { resolveApprovalFromContext } from "./approval";
import { BUILTIN_TOOL_NAMES } from "./builtin-names";

const planTaskSchema = type({
	id: type("string").describe("stable task id"),
	title: type("string").describe("short task title"),
	description: type("string").describe("what the worker must do"),
	"dependencies?": type("string").array().describe("task ids that must finish first"),
	"targetFiles?": type("string").array().describe("files this task writes; leases enforce exclusivity"),
	"agent?": type("string").describe("worker id from `workers`; defaults to the first worker"),
});

const planWorkerSchema = type({
	id: type("string").describe("stable worker id"),
	"roleLabel?": type("string").describe("human label, e.g. `frontend`"),
	"agent?": type("string").describe("agent definition name; defaults to the session agent"),
	"model?": type("string").describe("optional model pattern override for this worker"),
	"tools?": type("string").array().describe("tools this worker requests; intersected with parent active tools"),
	"isolated?": type("boolean").describe(
		"run this worker in its own worktree and merge its branch afterwards; use when parallel edits could collide",
	),
});

const orchestrateSchema = type({
	goal: type("string").describe("one sentence describing the whole run"),
	tasks: planTaskSchema.array().atLeastLength(1),
	"workers?": planWorkerSchema.array(),
});

export type OrchestrateParams = typeof orchestrateSchema.infer;

export interface OrchestrateDetails {
	readonly planId?: string;
	readonly stoppedReason?: string;
	readonly usage?: { totalTokens?: number; requests?: number };
	readonly outcomes?: Array<{
		taskId: string;
		state: string;
		workerId?: string;
		exitCode?: number;
		output?: string;
		branchName?: string;
		attempts?: number;
		error?: string;
		/**
		 * Present when the verification gate rejected the worker's output: the
		 * failing check id plus its truncated output, which is the only clue that
		 * distinguishes "the code is wrong" from "the worker crashed".
		 */
		verificationFailure?: { check: string; output: string };
	}>;
	/** Live pane snapshot, present on streamed updates while the run is in flight. */
	readonly panes?: readonly WorkerPane[];
	readonly error?: string;
}

function sanitizeRenderLine(text: string, maxWidth: number = TRUNCATE_LENGTHS.LINE): string {
	const shortened = text
		.split(" ")
		.map(token => shortenPath(token))
		.join(" ");
	return truncateToWidth(replaceTabs(shortened), maxWidth);
}

/** Build the engine plan from tool arguments, filling worker defaults. */
export function buildPlan(params: OrchestrateParams, defaultWorkerCount = 1): OrchestratorPlan {
	const autoWorkerCount = Math.max(1, Math.min(params.tasks.length, Math.max(1, Math.trunc(defaultWorkerCount))));
	const workers: WorkerSpec[] =
		params.workers && params.workers.length > 0
			? params.workers.map(worker => ({
					id: worker.id,
					roleLabel: worker.roleLabel ?? worker.id,
					backend: "native" as const,
					...(worker.agent === undefined ? {} : { agent: worker.agent }),
					...(worker.model === undefined ? {} : { model: worker.model }),
					...(worker.tools === undefined ? {} : { requestedTools: worker.tools }),
					isolated: worker.isolated ?? false,
				}))
			: Array.from({ length: autoWorkerCount }, (_, index) => {
					const id = `worker-${index + 1}`;
					return {
						id,
						roleLabel: id,
						backend: "native" as const,
						isolated: false,
					};
				});

	const tasks: OrchestratorTask[] = params.tasks.map(task => ({
		id: task.id,
		title: task.title,
		description: task.description,
		dependencies: task.dependencies ?? [],
		targetFiles: task.targetFiles ?? [],
		...(task.agent === undefined ? {} : { agent: task.agent }),
	}));

	return { id: `orchestrate-${Date.now().toString(36)}`, goal: params.goal, tasks, workers };
}

/** Render the run report as the tool result text. */
function renderReport(details: OrchestrateDetails): string {
	const lines: string[] = [];
	if (details.planId) lines.push(`Plan ${sanitizeRenderLine(details.planId, TRUNCATE_LENGTHS.TITLE)}`);
	if (details.stoppedReason) lines.push(`Stopped: ${sanitizeRenderLine(details.stoppedReason)}`);
	const outcomes = details.outcomes ?? [];
	const completed = outcomes.filter(outcome => outcome.state === "completed").length;
	lines.push(`${completed}/${outcomes.length} tasks completed`);
	for (const outcome of outcomes) {
		const mark = outcome.state === "completed" ? "✓" : "✗";
		const branchBit = outcome.branchName
			? ` [${sanitizeRenderLine(outcome.branchName, TRUNCATE_LENGTHS.SHORT)}]`
			: "";
		const detail = outcome.error ? ` — ${sanitizeRenderLine(outcome.error)}` : "";
		lines.push(
			`  ${mark} ${sanitizeRenderLine(outcome.taskId, TRUNCATE_LENGTHS.TITLE)}: ${outcome.state}${branchBit}${detail}`,
		);
		if (outcome.output && outcome.output.trim().length > 0) {
			const outputLines = outcome.output
				.trim()
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line.length > 0)
				.slice(0, PREVIEW_LIMITS.OUTPUT_COLLAPSED);
			for (const line of outputLines) {
				lines.push(`      ${sanitizeRenderLine(line)}`);
			}
		}
		// A rejected output is a different failure from a crashed worker, and the
		// check that rejected it is the actionable part.
		if (outcome.verificationFailure) {
			const { check, output } = outcome.verificationFailure;
			lines.push(`      verification failed: ${sanitizeRenderLine(check, TRUNCATE_LENGTHS.SHORT)}`);
			const failureLines = output.trim().split(/\r?\n/).slice(-PREVIEW_LIMITS.EXPANDED_LINES);
			for (const line of failureLines) {
				lines.push(`        ${sanitizeRenderLine(line)}`);
			}
		}
	}
	if (details.usage) {
		lines.push(`Usage: ${details.usage.totalTokens ?? 0} tokens across ${details.usage.requests ?? 0} request(s)`);
	}
	return lines.join("\n");
}

/** Streamed board repaints are throttled to this cadence while a run is live. */
const BOARD_UPDATE_MS = 250;

/** Render the pane snapshot as the plain-text body a non-TUI caller sees. */
export function renderBoardText(panes: readonly WorkerPane[]): string {
	if (panes.length === 0) return "No workers yet.";
	const lines: string[] = [];
	for (const pane of panes) {
		const bits = [`[${pane.state}]`, sanitizeRenderLine(pane.label, TRUNCATE_LENGTHS.SHORT)];
		const taskLabel = pane.taskTitle ?? pane.taskId;
		if (taskLabel) bits.push(`· ${sanitizeRenderLine(taskLabel, TRUNCATE_LENGTHS.TITLE)}`);
		if (pane.branchName) bits.push(`· ${sanitizeRenderLine(pane.branchName, TRUNCATE_LENGTHS.SHORT)}`);
		if (pane.tokens !== undefined) bits.push(`· ${pane.tokens} tok`);
		lines.push(bits.join(" "));
		const tail = (pane.output ?? []).slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		for (const line of tail) lines.push(`    ${sanitizeRenderLine(line)}`);
		if (pane.error) lines.push(`    ! ${sanitizeRenderLine(pane.error)}`);
	}
	return lines.join("\n");
}

export class OrchestrateTool implements AgentTool<typeof orchestrateSchema, OrchestrateDetails> {
	readonly name = "orchestrate";
	readonly approval = "exec" as const;
	readonly label = "Orchestrate";
	readonly summary = "Run a multi-agent task DAG with file leases, budgets, and verification";
	readonly description: string;
	readonly parameters = orchestrateSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly agents: AgentDefinition[],
	) {
		this.description = prompt.render(orchestrateDescription);
	}

	/** Discover the agent definitions this session may spawn, like `task` does. */
	static async create(session: ToolSession): Promise<OrchestrateTool> {
		const { agents } = await discoverAgents(session.cwd, undefined, session.effectiveExtensionRoots?.());
		return new OrchestrateTool(session, agents);
	}

	/** Session spawn policy: the default agent and whether spawning is allowed. */
	#spawnPolicy(): { defaultAgent: string; enabled: boolean } {
		const policy = resolveSpawnPolicy(this.session.getSessionSpawns?.() ?? null);
		return { defaultAgent: policy.defaultAgent, enabled: policy.enabled };
	}

	/** Tool names currently active in the parent session, always excluding `"orchestrate"`. */
	#activeToolNames(): string[] {
		const sessionWithEnabled = this.session as ToolSession & {
			getEnabledToolNames?: () => readonly string[];
		};
		if (typeof sessionWithEnabled.getEnabledToolNames === "function") {
			return sessionWithEnabled.getEnabledToolNames().filter(name => name !== "orchestrate");
		}
		if (typeof this.session.getEvalBridgeToolNames === "function") {
			return this.session.getEvalBridgeToolNames().filter(name => name !== "orchestrate");
		}
		const names = new Set<string>();
		for (const name of BUILTIN_TOOL_NAMES) {
			if (name === "orchestrate") continue;
			if (this.session.isToolActive?.(name) === true) names.add(name);
		}
		if (this.session.toolRegistry) {
			for (const name of this.session.toolRegistry.keys()) {
				if (name === "orchestrate") continue;
				if (this.session.isToolActive?.(name) === true) names.add(name);
			}
		}
		return [...names];
	}

	#resolveConcurrency(plan: OrchestratorPlan, maxConcurrency: number): number {
		const mode = cfgOrchestratorMode.get(this.session.settings);
		const touchPoints = Math.max(1, Math.trunc(Number(cfgOrchestratorTouchPoints.get(this.session.settings)) || 1));
		const independentTaskCount = plan.tasks.filter(task => task.dependencies.length === 0).length;
		const declaredTargets = [...new Set(plan.tasks.flatMap(task => task.targetFiles))];
		const fileTargets =
			declaredTargets.length > 0 ? declaredTargets.length : Math.max(touchPoints, plan.tasks.length);
		const moduleCount =
			declaredTargets.length > 0
				? Math.max(
						countModules(declaredTargets),
						fileTargets >= touchPoints ? DEFAULT_ROUTER_THRESHOLDS.minModules : 0,
					)
				: Math.max(DEFAULT_ROUTER_THRESHOLDS.minModules, independentTaskCount);
		const decision = decideFanOut(
			{
				taskCount: plan.tasks.length,
				independentTaskCount,
				fileTargets,
				moduleCount,
				platform: isAndroid() ? "android" : "desktop",
				estimatedRuntimeMs: DEFAULT_ROUTER_THRESHOLDS.minEstimatedRuntimeMs,
			},
			{
				mode,
				thresholds: {
					...DEFAULT_ROUTER_THRESHOLDS,
					touchPoints,
				},
			},
		);
		return decision.fanOut ? maxConcurrency : 1;
	}

	async execute(
		toolCallId: string,
		params: OrchestrateParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<OrchestrateDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<OrchestrateDetails>> {
		if (!cfgOrchestratorEnabled.get(this.session.settings)) {
			return {
				content: [
					{
						type: "text",
						text: "The multi-agent orchestrator is disabled. Enable `orchestrator.enabled` to use it.",
					},
				],
				details: { error: "orchestrator-disabled" },
			};
		}

		const limits = resolveOrchestratorLimits(this.session.settings);
		const plan = buildPlan(params, limits.concurrency);
		// Cycles and unknown dependencies are caught before any worker spawns, so a
		// malformed plan never burns budget.
		const problem = validatePlan(plan);
		if (problem) {
			return { content: [{ type: "text", text: problem }], details: { error: problem } };
		}

		const policy = this.#spawnPolicy();
		if (!policy.enabled) {
			return {
				content: [{ type: "text", text: "Spawning subagents is disabled for this session." }],
				details: { error: "spawning-disabled" },
			};
		}
		const agent = getAgent(this.agents, policy.defaultAgent);
		if (!agent) {
			return {
				content: [{ type: "text", text: `Agent definition \`${policy.defaultAgent}\` was not found.` }],
				details: { error: "agent-not-found" },
			};
		}

		const { approvalMode, userPolicies } = resolveApprovalFromContext({
			autoApprove: context?.autoApprove,
			settings: context?.settings ?? this.session.settings,
		});
		const effectiveConcurrency = this.#resolveConcurrency(plan, limits.concurrency);

		const engine = createNativeOrchestrationEngine({
			settings: this.session.settings,
			cwd: this.session.cwd,
			agent,
			agents: this.agents,
			parentActiveTools: this.#activeToolNames(),
			parentApprovalMode: approvalMode,
			userToolPolicies: userPolicies,
			taskDepth: (this.session.taskDepth ?? 0) + 1,
			parentAgentId: this.session.getAgentId?.() ?? undefined,
			planId: plan.id,
			parentToolCallId: toolCallId || undefined,
			concurrency: effectiveConcurrency,
			session: this.session,
		});

		const onAbort = (): void => engine.stopAll("cancelled by caller");
		if (signal?.aborted) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}

		// Fold engine events into pane state and stream it out, so the caller's
		// UI shows one live pane per worker instead of a single spinner.
		const board = new BoardModel(plan);
		board.annotateTasks(plan);
		let lastUpdate = 0;
		let dirty = false;
		const emitBoardUpdate = (force = false): void => {
			if (!onUpdate) return;
			const now = Date.now();
			if (!force && now - lastUpdate < BOARD_UPDATE_MS) {
				dirty = true;
				return;
			}
			lastUpdate = now;
			dirty = false;
			const snapshot = board.snapshot();
			onUpdate({
				content: [{ type: "text", text: renderBoardText(snapshot) }],
				details: { planId: plan.id, panes: snapshot },
			});
		};
		const unsubscribe = engine.subscribe(event => {
			board.apply(event);
			if (event.type === "plan_finished") {
				emitBoardUpdate(true);
				return;
			}
			emitBoardUpdate(false);
		});

		let runActive = true;
		const unregisterLiveRun = registerLiveSwarmRun({
			planId: plan.id,
			goal: plan.goal,
			startedAt: Date.now(),
			getSnapshot: () => board.snapshot(),
			cancelWorker: workerId => {
				engine.cancelWorker(workerId, "cancelled from board");
			},
			stopAll: () => {
				engine.stopAll("stopped from board");
			},
			isActive: () => runActive,
		});
		this.session.registerDisposeCallback?.(unregisterLiveRun);

		const runStore = new SwarmRunStore();
		try {
			await runStore.saveRunStart(plan, this.session.cwd);
		} catch (error) {
			logger.debug("orchestrate run store start persistence failed", {
				planId: plan.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		try {
			logger.debug("orchestrate tool starting", {
				goal: plan.goal,
				tasks: plan.tasks.length,
				concurrency: effectiveConcurrency,
			});
			const report = await engine.run(plan);
			if (dirty) {
				emitBoardUpdate(true);
			}
			try {
				await runStore.saveRunComplete(plan, report, this.session.cwd);
			} catch (error) {
				logger.debug("orchestrate run store completion persistence failed", {
					planId: plan.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			const details: OrchestrateDetails = {
				planId: report.planId,
				stoppedReason: report.stoppedReason,
				usage: report.usage,
				outcomes: [...report.outcomes].map(([taskId, record]) => {
					const failedCheck =
						record.verification?.ok === false
							? record.verification.checks.find(candidate => !candidate.ok)
							: undefined;
					const branchName = engine.changesFor(taskId)?.branchName ?? record.outcome?.changes?.branchName;
					return {
						taskId,
						state: record.state,
						workerId: record.workerId,
						exitCode: record.outcome?.exitCode,
						...(record.outcome?.output !== undefined ? { output: record.outcome.output } : {}),
						...(branchName !== undefined ? { branchName } : {}),
						...(record.attempts !== undefined ? { attempts: record.attempts } : {}),
						error: record.error ?? record.outcome?.error,
						...(failedCheck === undefined
							? {}
							: { verificationFailure: { check: failedCheck.id, output: failedCheck.output } }),
					};
				}),
			};
			return { content: [{ type: "text", text: renderReport(details) }], details };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Orchestration failed: ${sanitizeRenderLine(message)}` }],
				details: { error: message },
			};
		} finally {
			runActive = false;
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/** Reject plans the engine would only discover after spending budget. */
export function validatePlan(plan: OrchestratorPlan): string | undefined {
	if (plan.workers.length === 0) return "A plan needs at least one worker";
	const workerIds = new Set<string>();
	const workerTargets = new Set<string>();
	for (const worker of plan.workers) {
		if (!worker.id || worker.id.trim().length === 0) return "Worker id cannot be empty";
		if (workerIds.has(worker.id)) return `Duplicate worker id: ${worker.id}`;
		workerIds.add(worker.id);
		workerTargets.add(worker.id);
		if (worker.roleLabel && worker.roleLabel.trim().length > 0) workerTargets.add(worker.roleLabel);
		if (worker.agent && worker.agent.trim().length > 0) workerTargets.add(worker.agent);
	}

	const ids = new Set<string>();
	for (const task of plan.tasks) {
		if (!task.id || task.id.trim().length === 0) return "Task id cannot be empty";
		if (ids.has(task.id)) return `Duplicate task id: ${task.id}`;
		ids.add(task.id);
	}
	for (const task of plan.tasks) {
		for (const dependency of task.dependencies) {
			if (!ids.has(dependency)) return `Task ${task.id} depends on unknown task ${dependency}`;
			if (dependency === task.id) return `Task ${task.id} depends on itself`;
		}
		if (task.agent !== undefined) {
			if (task.agent.trim().length === 0 || !workerTargets.has(task.agent)) {
				return `Task ${task.id} references unknown worker ${task.agent}`;
			}
		}
	}
	return hasCycle(plan) ? "The task graph contains a cycle" : undefined;
}

/** Depth-first cycle detection over the dependency edges. */
function hasCycle(plan: OrchestratorPlan): boolean {
	const byId = new Map(plan.tasks.map(task => [task.id, task]));
	const visiting = new Set<string>();
	const done = new Set<string>();
	const visit = (id: string): boolean => {
		if (done.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		const task = byId.get(id);
		if (task) {
			for (const dependency of task.dependencies) {
				if (visit(dependency)) return true;
			}
		}
		visiting.delete(id);
		done.add(id);
		return false;
	};
	return plan.tasks.some(task => visit(task.id));
}

/** Guard against a malformed argument object reaching the plan builder. */
export function isOrchestrateParams(value: unknown): value is OrchestrateParams {
	return isRecord(value) && typeof value.goal === "string" && Array.isArray(value.tasks);
}
