/**
 * Headless CLI for Mars Swarm (`mars swarm`).
 *
 * Subcommands:
 * - `mars swarm list` (or `runs`) — list recent persisted swarm runs
 * - `mars swarm status [planId]` — inspect detailed per-task status, usage, and log summary
 * - `mars swarm validate <spec-file>` — parse and validate a YAML/JSON swarm spec and print the resolved DAG
 * - `mars swarm run <spec-file> [--dry-run] [--workers <n>] [--mode <auto|single|parallel>]` — run or dry-run a spec
 * - `mars swarm resume <planId> [--dry-run] [--workers <n>] [--mode <auto|single|parallel>]` — resume incomplete tasks
 */

import * as path from "node:path";
import { getProjectDir } from "@marsai-org/utils";
import { Args, Command, Flags } from "@marsai-org/utils/cli";
import { swarmHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { type EngineReport, type EngineRunner, OrchestrationEngine } from "../orchestrator/engine";
import { MAX_ORCHESTRATOR_WORKERS } from "../orchestrator/mode";
import { createNativeOrchestrationEngine } from "../orchestrator/native-runner";
import {
	buildResumePlan,
	type PersistedSwarmRun,
	type PersistedSwarmRunSummary,
	SwarmRunStore,
} from "../orchestrator/run-store";
import { cfgOrchestratorMode, resolveOrchestratorLimits } from "../orchestrator/settings";
import { loadSwarmSpec, type SwarmSpec, specToOrchestratorPlan } from "../orchestrator/spec-loader";
import type { OrchestratorPlan } from "../orchestrator/types";
import { ShellVerifier, type VerificationCheck } from "../orchestrator/verifier";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { discoverAuthStorage, type ToolSession } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { discoverAgents, getAgent } from "../task/discovery";
import { type ApprovalMode, resolveApprovalFromContext } from "../tools/approval";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";
import { validatePlan } from "../tools/orchestrate";
import { EventBus } from "../utils/event-bus";

export type SwarmCliAction = "list" | "runs" | "status" | "validate" | "run" | "resume";
export type SwarmFanOutMode = "auto" | "single" | "parallel";

export interface SwarmCliCommandOptions {
	readonly action?: string;
	readonly target?: string;
	readonly cwd?: string;
	readonly dryRun?: boolean;
	readonly workers?: number;
	readonly mode?: string;
	readonly approvalMode?: string;
	readonly autoApprove?: boolean;
	readonly limit?: number;
	readonly json?: boolean;
	readonly store?: SwarmRunStore;
	readonly runner?: EngineRunner;
	readonly signal?: AbortSignal;
	readonly onOutput?: (text: string) => void;
	readonly onError?: (text: string) => void;
}

export interface SwarmCliCommandResult {
	readonly exitCode: number;
	readonly output: string;
}

const VALID_MODES = new Set<SwarmFanOutMode>(["auto", "single", "parallel"]);
const VALID_APPROVAL_MODES = new Set<ApprovalMode>(["always-ask", "write", "yolo"]);

function formatPlanOverview(
	plan: OrchestratorPlan,
	spec?: SwarmSpec,
	extra?: { workers?: number; mode?: string },
): string {
	const lines: string[] = [];
	lines.push(`Plan: ${plan.id}`);
	lines.push(`Goal: ${plan.goal}`);
	if (spec) {
		lines.push(`Mode: ${spec.mode}${spec.iterations > 1 ? ` (${spec.iterations} iterations)` : ""}`);
	}
	if (extra?.mode) {
		lines.push(`Fan-out policy: ${extra.mode}`);
	}
	if (extra?.workers !== undefined) {
		lines.push(`Max concurrent workers: ${extra.workers}`);
	}
	lines.push(`Workers (${plan.workers.length}):`);
	for (const worker of plan.workers) {
		const tags: string[] = [`backend=${worker.backend}`, `isolated=${worker.isolated}`];
		if (worker.agent) tags.push(`agent=${worker.agent}`);
		if (worker.model) tags.push(`model=${worker.model}`);
		if (worker.requestedTools && worker.requestedTools.length > 0) {
			tags.push(`tools=${worker.requestedTools.join(",")}`);
		}
		lines.push(`  - ${worker.id} (${worker.roleLabel}) [${tags.join(", ")}]`);
	}
	lines.push(`Tasks (${plan.tasks.length}):`);
	for (const task of plan.tasks) {
		const deps = task.dependencies.length > 0 ? ` deps=[${task.dependencies.join(", ")}]` : "";
		const files = task.targetFiles.length > 0 ? ` files=[${task.targetFiles.join(", ")}]` : "";
		const agent = task.agent ? ` worker=${task.agent}` : "";
		lines.push(`  - ${task.id}: ${task.title}${agent}${deps}${files}`);
	}
	return lines.join("\n");
}

function formatRunList(runs: readonly PersistedSwarmRunSummary[]): string {
	if (runs.length === 0) {
		return "No persisted swarm runs found.";
	}
	const lines: string[] = [`Persisted swarm runs (${runs.length}):`];
	for (const run of runs) {
		const updated = new Date(run.updatedAt).toISOString();
		lines.push(
			`  ${run.planId}  [${run.status}]  ${run.completedTasks}/${run.totalTasks} completed${run.failedTasks > 0 ? ` (${run.failedTasks} failed)` : ""}  ${updated}  — ${run.goal}`,
		);
	}
	return lines.join("\n");
}

async function formatRunStatus(run: PersistedSwarmRun, store: SwarmRunStore): Promise<string> {
	const lines: string[] = [];
	lines.push(`Plan: ${run.planId}`);
	lines.push(`Goal: ${run.goal}`);
	lines.push(`Status: ${run.status}${run.stoppedReason ? ` (${run.stoppedReason})` : ""}`);
	lines.push(`Directory: ${run.cwd}`);
	lines.push(`Updated: ${new Date(run.updatedAt).toISOString()}`);
	lines.push(
		`Usage: ${run.usage.totalTokens} tokens (${run.usage.inputTokens} in / ${run.usage.outputTokens} out), ${run.usage.requests} request(s), ${run.usage.wallClockMs}ms`,
	);
	lines.push(`Tasks (${run.plan.tasks.length}):`);

	for (const task of run.plan.tasks) {
		const record = run.tasks[task.id];
		const state = record?.state ?? "pending";
		const worker = record?.workerId ? ` worker=${record.workerId}` : "";
		const branch = record?.branchName ? ` branch=${record.branchName}` : "";
		const exit = record?.exitCode !== undefined ? ` exit=${record.exitCode}` : "";
		lines.push(`  - [${state}] ${task.id}: ${task.title}${worker}${exit}${branch}`);
		if (record?.error) {
			lines.push(`      error: ${record.error}`);
		}
		if (record?.verification) {
			const verdict = record.verification.ok
				? "PASS"
				: `FAIL (${record.verification.firstFailure ?? "check failed"})`;
			lines.push(`      verification: ${verdict}`);
		}
		if (record?.logFile) {
			const logContent = await store.readTaskLog(run.planId, task.id);
			const logPreview = logContent ? logContent.trim().split(/\r?\n/).slice(-3).join(" | ") : undefined;
			lines.push(`      log: ${record.logFile}${logPreview ? ` — ${logPreview}` : ""}`);
		}
	}

	return lines.join("\n");
}

function formatEngineReport(plan: OrchestratorPlan, report: EngineReport): string {
	const lines: string[] = [];
	const records = [...report.outcomes.entries()];
	const completed = records.filter(([, record]) => record.state === "completed").length;
	lines.push(`Plan ${report.planId}: ${completed}/${plan.tasks.length} tasks completed`);
	if (report.stoppedReason) {
		lines.push(`Stopped: ${report.stoppedReason}`);
	}
	for (const task of plan.tasks) {
		const record = report.outcomes.get(task.id);
		const state = record?.state ?? "pending";
		const mark = state === "completed" ? "✓" : "✗";
		const error = record?.error ?? record?.outcome?.error;
		lines.push(`  ${mark} ${task.id} (${task.title}): ${state}${error ? ` — ${error}` : ""}`);
	}
	lines.push(`Usage: ${report.usage.totalTokens} tokens across ${report.usage.requests} request(s)`);
	return lines.join("\n");
}

async function executeHeadlessPlan(
	plan: OrchestratorPlan,
	options: {
		cwd: string;
		store: SwarmRunStore;
		workers?: number;
		mode?: SwarmFanOutMode;
		approvalMode?: ApprovalMode;
		autoApprove?: boolean;
		verificationChecks?: readonly string[];
		runner?: EngineRunner;
		signal?: AbortSignal;
	},
): Promise<EngineReport> {
	const { cwd, store } = options;
	const checks: VerificationCheck[] = (options.verificationChecks ?? [])
		.map(cmd => cmd.trim())
		.filter(cmd => cmd.length > 0)
		.map((command, index) => ({ id: `check-${index + 1}`, command }));

	let engine: OrchestrationEngine;
	if (options.runner) {
		engine = new OrchestrationEngine({
			runner: options.runner,
			concurrency: options.mode === "single" ? 1 : (options.workers ?? 4),
			maxRetries: plan.maxRetries ?? 1,
			...(checks.length > 0
				? { verifier: new ShellVerifier(), verificationChecks: checks, verificationRoot: cwd }
				: {}),
		});
	} else {
		const settings = await Settings.init({ cwd });
		const authStorage = await discoverAuthStorage(undefined, { settings });
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh();
		const sessionManager = SessionManager.create(cwd);
		await sessionManager.setSessionName(`Swarm ${plan.id}`, "auto");
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		const eventBus = new EventBus();
		const { agents } = await discoverAgents(cwd);
		const defaultAgent = getAgent(agents, "task") ?? agents[0];
		if (!defaultAgent) {
			throw new Error("No task agent definition found for headless swarm execution");
		}
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			suppressSpawnAdvisory: true,
			enableLsp: true,
			enableIrc: true,
			enableMCP: false,
			eventBus,
			getSessionFile: () => sessionFile ?? null,
			getSessionId: () => sessionManager.getSessionId(),
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getArtifactManager: () => sessionManager.getArtifactManager(),
			getAgentId: () => MAIN_AGENT_ID,
			getSessionSpawns: () => "*",
			sessionManager,
			settings,
			authStorage,
			modelRegistry,
		};
		const limits = resolveOrchestratorLimits(settings);
		if (limits.concurrency < 1) {
			throw new Error("Invalid orchestrator concurrency limit");
		}
		const effectiveMode = options.mode ?? cfgOrchestratorMode.get(settings);
		const effectiveConcurrency = effectiveMode === "single" ? 1 : (options.workers ?? limits.concurrency);
		const resolvedApproval = resolveApprovalFromContext({
			autoApprove: options.autoApprove,
			settings,
		});
		const parentApprovalMode: ApprovalMode =
			options.autoApprove === true ? "yolo" : (options.approvalMode ?? resolvedApproval.approvalMode);
		engine = createNativeOrchestrationEngine({
			settings,
			cwd,
			agent: defaultAgent,
			agents,
			parentActiveTools: [...BUILTIN_TOOL_NAMES].filter(name => name !== "orchestrate"),
			parentApprovalMode,
			userToolPolicies: resolvedApproval.userPolicies,
			taskDepth: 1,
			parentAgentId: MAIN_AGENT_ID,
			planId: plan.id,
			concurrency: effectiveConcurrency,
			...(plan.maxRetries !== undefined ? { maxRetries: plan.maxRetries } : {}),
			...(checks.length > 0 ? { verificationChecks: checks } : {}),
			session: toolSession,
		});
	}

	const onAbort = (): void => engine.stopAll("cancelled by caller");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await store.saveRunStart(plan, cwd);
		const report = await engine.run(plan);
		await store.saveRunComplete(plan, report, cwd);
		return report;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function runSwarmCliCommand(options: SwarmCliCommandOptions): Promise<SwarmCliCommandResult> {
	const action = (options.action ?? "list").toLowerCase();
	const cwd = options.cwd ?? getProjectDir();
	const store = options.store ?? new SwarmRunStore();
	const outLines: string[] = [];
	const emit = (text: string): void => {
		outLines.push(text);
		options.onOutput?.(text);
	};
	const emitError = (text: string): void => {
		outLines.push(text);
		options.onError?.(text);
	};

	if (options.workers !== undefined) {
		if (!Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > MAX_ORCHESTRATOR_WORKERS) {
			const msg = `Error: --workers must be a positive integer between 1 and ${MAX_ORCHESTRATOR_WORKERS}`;
			emitError(msg);
			return { exitCode: 1, output: outLines.join("\n") };
		}
	}

	let fanOutMode: SwarmFanOutMode | undefined;
	if (options.mode !== undefined) {
		const normalized = options.mode.toLowerCase() as SwarmFanOutMode;
		if (!VALID_MODES.has(normalized)) {
			const msg = "Error: --mode must be one of: auto, single, parallel";
			emitError(msg);
			return { exitCode: 1, output: outLines.join("\n") };
		}
		fanOutMode = normalized;
	}

	let approvalMode: ApprovalMode | undefined;
	if (options.approvalMode !== undefined) {
		const normalized = options.approvalMode.toLowerCase() as ApprovalMode;
		if (!VALID_APPROVAL_MODES.has(normalized)) {
			const msg = "Error: --approval-mode must be one of: always-ask, write, yolo";
			emitError(msg);
			return { exitCode: 1, output: outLines.join("\n") };
		}
		approvalMode = normalized;
	}

	switch (action) {
		case "list":
		case "runs": {
			const runs = await store.listRuns(options.limit ?? 20);
			if (options.json) {
				emit(JSON.stringify(runs, null, 2));
			} else {
				emit(formatRunList(runs));
			}
			return { exitCode: 0, output: outLines.join("\n") };
		}

		case "status": {
			let targetId = options.target?.trim();
			if (!targetId) {
				const latest = await store.listRuns(1);
				targetId = latest[0]?.planId;
			}
			if (!targetId) {
				emitError("No persisted swarm runs found.");
				return { exitCode: 1, output: outLines.join("\n") };
			}
			const run = await store.loadRun(targetId);
			if (!run) {
				emitError(`Swarm run "${targetId}" not found.`);
				return { exitCode: 1, output: outLines.join("\n") };
			}
			if (options.json) {
				emit(JSON.stringify(run, null, 2));
			} else {
				emit(await formatRunStatus(run, store));
			}
			return { exitCode: 0, output: outLines.join("\n") };
		}

		case "validate": {
			const specArg = options.target?.trim();
			if (!specArg) {
				emitError("Error: Missing required argument <spec-file> for `mars swarm validate`");
				return { exitCode: 1, output: outLines.join("\n") };
			}
			const specPath = path.resolve(cwd, specArg);
			try {
				const spec = await loadSwarmSpec(specPath);
				const plan = specToOrchestratorPlan(spec);
				const problem = validatePlan(plan);
				if (problem) {
					emitError(`Invalid swarm plan: ${problem}`);
					return { exitCode: 1, output: outLines.join("\n") };
				}
				if (options.json) {
					emit(JSON.stringify({ valid: true, spec, plan }, null, 2));
				} else {
					emit(`Valid swarm spec: ${specPath}\n${formatPlanOverview(plan, spec)}`);
				}
				return { exitCode: 0, output: outLines.join("\n") };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				emitError(`Validation failed: ${detail}`);
				return { exitCode: 1, output: outLines.join("\n") };
			}
		}

		case "run": {
			const specArg = options.target?.trim();
			if (!specArg) {
				emitError("Error: Missing required argument <spec-file> for `mars swarm run`");
				return { exitCode: 1, output: outLines.join("\n") };
			}
			const specPath = path.resolve(cwd, specArg);
			let spec: SwarmSpec;
			try {
				spec = await loadSwarmSpec(specPath);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				emitError(`Failed to load swarm spec: ${detail}`);
				return { exitCode: 1, output: outLines.join("\n") };
			}

			const effectiveWorkers = options.workers ?? spec.maxConcurrency;
			const plans: OrchestratorPlan[] = [];
			for (let iteration = 1; iteration <= spec.iterations; iteration++) {
				const plan = specToOrchestratorPlan(spec, iteration);
				const problem = validatePlan(plan);
				if (problem) {
					emitError(`Invalid swarm plan: ${problem}`);
					return { exitCode: 1, output: outLines.join("\n") };
				}
				plans.push(plan);
			}

			if (options.dryRun) {
				if (options.json) {
					emit(
						JSON.stringify(
							{
								dryRun: true,
								spec,
								workers: effectiveWorkers,
								mode: fanOutMode,
								plans,
							},
							null,
							2,
						),
					);
				} else {
					const previews = plans.map(plan =>
						formatPlanOverview(plan, spec, { workers: effectiveWorkers, mode: fanOutMode }),
					);
					emit(`Dry run (${plans.length} pass(es)):\n${previews.join("\n\n")}`);
				}
				return { exitCode: 0, output: outLines.join("\n") };
			}

			let allSucceeded = true;
			for (const plan of plans) {
				const report = await executeHeadlessPlan(plan, {
					cwd,
					store,
					workers: effectiveWorkers,
					mode: fanOutMode,
					approvalMode,
					autoApprove: options.autoApprove,
					verificationChecks: spec.verificationChecks,
					runner: options.runner,
					signal: options.signal,
				});
				emit(formatEngineReport(plan, report));
				const failed =
					report.stoppedReason !== undefined ||
					plan.tasks.some(task => report.outcomes.get(task.id)?.state !== "completed");
				if (failed) {
					allSucceeded = false;
					break;
				}
			}

			return { exitCode: allSucceeded ? 0 : 1, output: outLines.join("\n") };
		}

		case "resume": {
			const planId = options.target?.trim();
			if (!planId) {
				emitError("Error: Missing required argument <planId> for `mars swarm resume`");
				return { exitCode: 1, output: outLines.join("\n") };
			}
			const run = await store.loadRun(planId);
			if (!run) {
				emitError(`Swarm run "${planId}" not found.`);
				return { exitCode: 1, output: outLines.join("\n") };
			}
			const resumePlan = buildResumePlan(run);
			if (!resumePlan) {
				const msg = `All tasks in swarm run "${planId}" are already completed.`;
				if (options.json) {
					emit(JSON.stringify({ planId, completed: true, remainingTasks: 0 }, null, 2));
				} else {
					emit(msg);
				}
				return { exitCode: 0, output: outLines.join("\n") };
			}

			if (options.dryRun) {
				if (options.json) {
					emit(JSON.stringify({ dryRun: true, planId, resumePlan }, null, 2));
				} else {
					emit(
						`Dry run resume for ${planId} (${resumePlan.tasks.length} remaining task(s)):\n${formatPlanOverview(resumePlan, undefined, { workers: options.workers, mode: fanOutMode })}`,
					);
				}
				return { exitCode: 0, output: outLines.join("\n") };
			}

			const report = await executeHeadlessPlan(resumePlan, {
				cwd: run.cwd || cwd,
				store,
				workers: options.workers,
				mode: fanOutMode,
				approvalMode,
				autoApprove: options.autoApprove,
				runner: options.runner,
				signal: options.signal,
			});
			emit(formatEngineReport(resumePlan, report));
			const failed =
				report.stoppedReason !== undefined ||
				resumePlan.tasks.some(task => report.outcomes.get(task.id)?.state !== "completed");
			return { exitCode: failed ? 1 : 0, output: outLines.join("\n") };
		}

		default: {
			emitError(`Unknown swarm action "${action}". Expected one of: list, runs, status, validate, run, resume.`);
			return { exitCode: 1, output: outLines.join("\n") };
		}
	}
}

export default class Swarm extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), runs, status, validate, run, or resume",
			required: false,
			options: ["list", "runs", "status", "validate", "run", "resume"],
			default: "list",
		}),
		target: Args.string({
			description: "Spec file path (validate, run) or planId (status, resume)",
			required: false,
		}),
	};

	static flags = {
		"dry-run": Flags.boolean({
			char: "n",
			description: "Validate and print the execution plan without running workers (run, resume)",
			default: false,
		}),
		workers: Flags.integer({
			char: "w",
			description: `Maximum concurrent workers (1..${MAX_ORCHESTRATOR_WORKERS})`,
		}),
		mode: Flags.string({
			char: "m",
			description: "Fan-out mode override (auto, single, parallel)",
		}),
		"approval-mode": Flags.string({
			description: "Tool approval mode override for workers (always-ask, write, yolo)",
		}),
		"auto-approve": Flags.boolean({
			description: "Auto-approve all worker tool calls (equivalent to --approval-mode yolo)",
			default: false,
		}),
		limit: Flags.integer({
			char: "l",
			description: "Maximum number of persisted runs to list",
			default: 20,
		}),
		"store-dir": Flags.string({
			description: "Custom directory for persisted swarm runs (defaults to ~/.mars/agent/swarms)",
		}),
		json: Flags.boolean({
			char: "j",
			description: "Emit machine-readable JSON output",
			default: false,
		}),
	};

	static examples = [
		"mars swarm list",
		"mars swarm status",
		"mars swarm status swarm-my-plan",
		"mars swarm validate ./swarm.yaml",
		"mars swarm run ./swarm.yaml --dry-run",
		"mars swarm run ./swarm.yaml --workers 4 --mode parallel",
		"mars swarm resume swarm-my-plan --dry-run",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Swarm);
		const store = flags["store-dir"] ? new SwarmRunStore(flags["store-dir"]) : new SwarmRunStore();
		const result = await runSwarmCliCommand({
			action: args.action,
			target: args.target,
			dryRun: flags["dry-run"] ?? false,
			workers: flags.workers,
			mode: flags.mode,
			approvalMode: flags["approval-mode"],
			autoApprove: flags["auto-approve"] ?? false,
			limit: flags.limit,
			json: flags.json ?? false,
			store,
			onOutput: text => console.log(text),
			onError: text => console.error(text),
		});
		if (result.exitCode !== 0) {
			process.exitCode = result.exitCode;
		}
	}
}
