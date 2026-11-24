/**
 * Native worker runner.
 *
 * The production {@link EngineRunner}: spawns each worker through the existing
 * structured-subagent pipeline, which owns isolation (a per-worker worktree or
 * copy-on-write checkout), change capture, and the branch/patch handoff. This
 * runner only decides *whether* a worker is isolated and translates the result
 * into an {@link WorkerOutcome}.
 *
 * The permission invariant still applies: {@link requireWorkerSpawn} intersects
 * the requested tools with the parent's active set before the child starts.
 *
 * Tests never use this runner against a real model; they inject a fake runner
 * or spy on `runStructuredSubagent`, so no test reaches a model or the network.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 3, 7, and Milestone 3.
 */

import type { AgentProgress, SingleResult } from "@marsai-org/tui/tools/task";
import type { Settings } from "../config/settings";
import { getAgent } from "../task/discovery";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import {
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import type { AgentDefinition } from "../task/types";
import type { ApprovalMode } from "../tools/approval";
import type { ToolSession } from "../tools";
import { OrchestrationEngine, type EngineRunner, type PendingIntegration, type WorkerRunContext } from "./engine";
import { GitIntegrator } from "./git-integrator";
import { IrcMessageTransport, type MessageTransport } from "./message-bus";
import {
	cfgOrchestratorAllowProjectVerificationChecks,
	cfgOrchestratorConflictResolution,
	cfgOrchestratorMaxRetries,
	cfgOrchestratorVerificationChecks,
	ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID,
	resolveOrchestratorBudget,
	resolveOrchestratorLimits,
	resolveOrchestratorVerificationChecks,
} from "./settings";
import { ShellVerifier, type VerificationCheck, verifyBranchInTempWorktree } from "./verifier";
import { requireWorkerSpawn } from "./worker-session";
import type { OrchestratorTask, WorkerChanges, WorkerOutcome, WorkerSpec, WorkerUsage } from "./types";

export interface NativeWorkerRunnerOptions {
	readonly settings: Settings;
	readonly cwd: string;
	/** Default agent definition every worker runs as unless overridden per worker. */
	readonly agent: AgentDefinition;
	/** Discovered agent definitions available for per-worker `spec.agent` resolution. */
	readonly agents?: readonly AgentDefinition[];
	/** Tool names the parent session currently has active. */
	readonly parentActiveTools: readonly string[];
	/** Parent session's approval mode; undefined when unknown. */
	readonly parentApprovalMode?: ApprovalMode;
	/** Optional user per-tool approval overrides (`tools.approval.<tool>: allow | deny | prompt`). */
	readonly userToolPolicies?: Readonly<Record<string, unknown>>;
	/** Nesting depth for the spawned sessions (0 for a top-level orchestrator). */
	readonly taskDepth?: number;
	/** Directory for worker artifacts (patches, outputs). */
	readonly artifactsDir?: string;
	/** Parent agent id, used for registry parentage. */
	readonly parentAgentId?: string;
	/** Plan identifier for run scoping. */
	readonly planId?: string;
	/** Parent tool call id for subagent lineage. */
	readonly parentToolCallId?: string;
	/** Whether finished worker sessions remain alive in AgentLifecycleManager. Defaults to false. */
	readonly persistentWorkers?: boolean;
	/** Optional concurrency override (e.g. from router fan-out decision or CLI `--workers`). */
	readonly concurrency?: number;
	/** Optional retry cap override (e.g. from declarative swarm spec `maxRetries`). */
	readonly maxRetries?: number;
	/** Optional verification checks override (e.g. from declarative swarm spec `verificationChecks`). */
	readonly verificationChecks?: readonly VerificationCheck[];
	/** Optional peer message transport override. */
	readonly transport?: MessageTransport;
	/**
	 * The session workers spawn from. Isolation, credentials, and extension
	 * discovery all read from it, so an orchestrated worker behaves exactly like
	 * a `task` subagent spawned by the same session.
	 */
	readonly session: ToolSession;
	/**
	 * Force every worker into its own checkout regardless of `WorkerSpec.isolated`.
	 * Set when the plan's tasks write to overlapping paths and the caller wants
	 * the merge phase to arbitrate instead of the lease manager serializing them.
	 */
	readonly forceIsolation?: boolean;
	/**
	 * Whether workers may run isolated at all. Defaults to true: a worker's own
	 * `isolated` flag then decides. Set false to keep every worker in the shared
	 * checkout and skip the integration phase entirely.
	 */
	readonly isolateWorkers?: boolean;
	/** Merge mode handed to the isolation pipeline. */
	readonly mergeMode?: "patch" | "branch";
}

function buildSubagentId(workerId: string, taskId: string, attempt: number): string {
	const raw = `${workerId}-${taskId}${attempt > 1 ? `-r${attempt}` : ""}`;
	const sanitized = raw
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "worker-task";
}

function buildWorkerAssignment(task: OrchestratorTask, context: WorkerRunContext): string {
	const sections: string[] = [task.description];
	if (context.leases.length > 0) {
		const leaseLines = context.leases.map(lease => `- ${lease.path} (${lease.mode})`).join("\n");
		sections.push(`Active file leases:\n${leaseLines}`);
	}
	const retryFeedback = context.retryFeedback ?? task.retryFeedback;
	if (retryFeedback && retryFeedback.trim().length > 0) {
		sections.push(`Previous attempt failed verification:\n${retryFeedback.trim()}`);
	}
	return sections.join("\n\n");
}

function extractProgressOutputLine(progress: AgentProgress): string | undefined {
	if (Array.isArray(progress.recentOutput)) {
		for (let i = progress.recentOutput.length - 1; i >= 0; i--) {
			const candidate = progress.recentOutput[i]?.trim();
			if (candidate) return candidate;
		}
	}
	if (progress.currentTool) {
		const args = progress.currentToolArgs?.trim();
		return args ? `${progress.currentTool}: ${args}` : progress.currentTool;
	}
	if (Array.isArray(progress.recentTools) && progress.recentTools.length > 0) {
		const latest = progress.recentTools[progress.recentTools.length - 1];
		if (latest?.tool) {
			const args = latest.args?.trim();
			return args ? `${latest.tool}: ${args}` : latest.tool;
		}
	}
	const intent = progress.lastIntent?.trim();
	return intent || undefined;
}

function toWorkerUsage(result: SingleResult): WorkerUsage {
	const rawUsage = result.usage as
		| {
				input?: number;
				inputTokens?: number;
				output?: number;
				outputTokens?: number;
				reasoning?: number;
				reasoningTokens?: number;
				cacheRead?: number;
				cacheReadTokens?: number;
				cacheWrite?: number;
				cacheWriteTokens?: number;
				totalTokens?: number;
		  }
		| undefined;
	const inputTokens = rawUsage?.inputTokens ?? rawUsage?.input;
	const outputTokens = rawUsage?.outputTokens ?? rawUsage?.output;
	const reasoningTokens = rawUsage?.reasoningTokens ?? rawUsage?.reasoning;
	const cacheReadTokens = rawUsage?.cacheReadTokens ?? rawUsage?.cacheRead;
	const cacheWriteTokens = rawUsage?.cacheWriteTokens ?? rawUsage?.cacheWrite;
	const totalTokens = result.tokens ?? rawUsage?.totalTokens;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(result.requests === undefined ? {} : { requests: result.requests }),
	};
}

function extractErrorResult(error: unknown): SingleResult | undefined {
	if (error instanceof StructuredSubagentError && error.result) {
		return error.result;
	}
	if (error !== null && typeof error === "object" && "result" in error) {
		const candidate = (error as { result?: unknown }).result;
		if (candidate !== null && typeof candidate === "object" && "tokens" in candidate) {
			return candidate as SingleResult;
		}
	}
	return undefined;
}

export class NativeWorkerRunner implements EngineRunner {
	readonly #options: NativeWorkerRunnerOptions;

	constructor(options: NativeWorkerRunnerOptions) {
		this.#options = options;
	}

	/** Whether this worker gets its own checkout. */
	#shouldIsolate(spec: WorkerSpec): boolean {
		if (this.#options.isolateWorkers === false) return false;
		return this.#options.forceIsolation === true || spec.isolated;
	}

	/** Resolve the agent definition for `spec`, falling back to the default runner agent. */
	#resolveWorkerAgent(spec: WorkerSpec): AgentDefinition {
		const requestedName = spec.agent?.trim();
		if (!requestedName || !this.#options.agents || this.#options.agents.length === 0) {
			return this.#options.agent;
		}
		const candidate = getAgent([...this.#options.agents], requestedName);
		if (!candidate) {
			return this.#options.agent;
		}
		const spawnPolicy = resolveSpawnPolicy(this.#options.session.getSessionSpawns?.() ?? null);
		if (!spawnPolicy.enabled) {
			return this.#options.agent;
		}
		if (spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(candidate.name)) {
			return this.#options.agent;
		}
		return candidate;
	}

	async run(spec: WorkerSpec, task: OrchestratorTask, context: WorkerRunContext): Promise<WorkerOutcome> {
		const isolated = this.#shouldIsolate(spec);
		try {
			const baseAgent = this.#resolveWorkerAgent(spec);
			const plan = requireWorkerSpawn({
				agent: baseAgent,
				parentActiveTools: this.#options.parentActiveTools,
				requestedTools: spec.requestedTools,
				parentApprovalMode: this.#options.parentApprovalMode,
				userToolPolicies: this.#options.userToolPolicies,
			});
			const modelOverride = spec.model?.trim() || undefined;
			// The structured pipeline resolves the agent by name from discovery, so the
			// intersected tool set rides a session-local agent definition rather than
			// mutating the shared one. `getSessionAgents` is the hook the pipeline
			// merges over discovered agents.
			const restrictedAgent: AgentDefinition = {
				...baseAgent,
				tools: [...plan.tools],
				...(modelOverride ? { model: [modelOverride] } : {}),
			};
			const existingSessionAgents = this.#options.session.getSessionAgents?.() ?? [];
			const session: ToolSession = {
				...this.#options.session,
				cwd: this.#options.cwd,
				taskDepth: this.#options.taskDepth ?? 0,
				restrictToolNames: true,
				...(this.#options.parentAgentId !== undefined
					? { getAgentId: () => this.#options.parentAgentId ?? null }
					: {}),
				...(this.#options.artifactsDir !== undefined
					? { getArtifactsDir: () => this.#options.artifactsDir ?? null }
					: {}),
				getSessionAgents: () => [
					...existingSessionAgents.filter(candidate => candidate.name !== restrictedAgent.name),
					restrictedAgent,
				],
			};

			const subagentId = buildSubagentId(spec.id, task.id, context.attempt);
			const assignment = buildWorkerAssignment(task, context);
			let lastOutputLine: string | undefined;

			const execution = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment,
				// Resolve to the restricted definition registered above and pass `tools`
				// explicitly so discovered agents (which take precedence over sessionAgents)
				// still honor the intersected permission plan.
				agent: restrictedAgent.name,
				tools: [...plan.tools],
				...(modelOverride ? { model: modelOverride } : {}),
				identity: { id: subagentId, label: spec.roleLabel },
				// Orchestrator recursion is already prevented by stripping `"orchestrate"`
				// from `parentActiveTools` and advancing `taskDepth`; passing `blockedAgent: baseAgent.name`
				// here would collide with `agent: restrictedAgent.name` in `assertDepthAndSpawnAllowed`
				// and unconditionally reject every worker spawn.
				keepAlive: this.#options.persistentWorkers ?? false,
				...(this.#options.parentToolCallId !== undefined
					? { parentToolCallId: this.#options.parentToolCallId }
					: {}),
				...(isolated
					? {
							isolation: {
								requested: true,
								merge: this.#options.mergeMode ?? "branch",
								apply: false,
								allowWithoutSetting: true,
							},
						}
					: {}),
				signal: context.signal,
				onProgress: progress => {
					if (!context.reportProgress) return;
					const candidateLine = extractProgressOutputLine(progress);
					const outputLine =
						candidateLine !== undefined && candidateLine !== lastOutputLine ? candidateLine : undefined;
					if (outputLine !== undefined) {
						lastOutputLine = outputLine;
					}
					const requests = progress.requests ?? (progress as AgentProgress & { turnCount?: number }).turnCount;
					const hasUsage = progress.tokens !== undefined || requests !== undefined;
					const usage: WorkerUsage | undefined = hasUsage
						? {
								...(progress.tokens !== undefined ? { totalTokens: progress.tokens } : {}),
								...(requests !== undefined ? { requests } : {}),
							}
						: undefined;
					if (outputLine !== undefined || usage !== undefined) {
						context.reportProgress({
							...(outputLine !== undefined ? { outputLine } : {}),
							...(usage !== undefined ? { usage } : {}),
						});
					}
				},
			});

			const result = execution.result;
			if (result.branchName) {
				context.reportProgress?.({ branchName: result.branchName });
			}
			return {
				exitCode: result.exitCode,
				output: result.output,
				error: result.error,
				usage: toWorkerUsage(result),
				...(isolated ? { changes: toWorkerChanges(execution) } : {}),
			};
		} catch (error) {
			// A spawn, permission, or isolation failure is a task failure, not a
			// reason to abort the whole plan: the engine marks this task failed and
			// cancels its dependents while independent tasks keep running.
			const partialResult = extractErrorResult(error);
			return {
				exitCode: 1,
				output: partialResult?.output ?? "",
				error: error instanceof Error ? error.message : String(error),
				...(partialResult ? { usage: toWorkerUsage(partialResult) } : {}),
			};
		}
	}
}

/** Project the structured-subagent result onto the orchestrator's change record. */
function toWorkerChanges(execution: StructuredSubagentResult): WorkerChanges {
	const result = execution.result;
	const hasChanges = result.patchPath !== undefined || result.branchName !== undefined;
	return {
		...(result.branchName === undefined ? {} : { branchName: result.branchName }),
		...(result.patchPath === undefined ? {} : { patchPath: result.patchPath }),
		...(result.branchBaseSha === undefined ? {} : { baseSha: result.branchBaseSha }),
		hasChanges,
		...(execution.mergeSummary ? { mergeSummary: execution.mergeSummary.trim() } : {}),
	};
}

function buildIntegratorConflictResolver(
	options: NativeWorkerRunnerOptions,
	integratorAgent: AgentDefinition,
): (
	entry: PendingIntegration,
	conflict: string,
	signal: AbortSignal,
) => Promise<{ resolved: boolean; detail?: string }> {
	return async (entry, conflict, signal) => {
		try {
			const plan = requireWorkerSpawn({
				agent: integratorAgent,
				parentActiveTools: options.parentActiveTools,
				parentApprovalMode: options.parentApprovalMode,
				userToolPolicies: options.userToolPolicies,
			});
			const restrictedIntegrator: AgentDefinition = {
				...integratorAgent,
				tools: [...plan.tools],
			};
			const existingSessionAgents = options.session.getSessionAgents?.() ?? [];
			const session: ToolSession = {
				...options.session,
				cwd: options.cwd,
				taskDepth: options.taskDepth ?? 0,
				restrictToolNames: true,
				...(options.parentAgentId !== undefined ? { getAgentId: () => options.parentAgentId ?? null } : {}),
				...(options.artifactsDir !== undefined ? { getArtifactsDir: () => options.artifactsDir ?? null } : {}),
				getSessionAgents: () => [
					...existingSessionAgents.filter(candidate => candidate.name !== restrictedIntegrator.name),
					restrictedIntegrator,
				],
			};
			const assignmentLines = [
				`Branch: ${entry.branchName}`,
				...(entry.baseSha ? [`Base SHA: ${entry.baseSha}`] : []),
				...(entry.targetFiles.length > 0 ? [`Target files: ${entry.targetFiles.join(", ")}`] : []),
				`Conflict: ${conflict}`,
			];
			const execution = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: assignmentLines.join("\n"),
				agent: restrictedIntegrator.name,
				tools: [...plan.tools],
				identity: { id: buildSubagentId("integrator", entry.taskId, 1), label: "integrator" },
				keepAlive: false,
				maxRuntimeMs: 300_000,
				...(options.parentToolCallId !== undefined ? { parentToolCallId: options.parentToolCallId } : {}),
				signal,
			});
			const ok = execution.result.exitCode === 0 && !execution.result.error && !execution.result.aborted;
			return {
				resolved: ok,
				detail: execution.result.error ?? (execution.result.output.trim() || undefined),
			};
		} catch (error) {
			return {
				resolved: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

/**
 * Build an orchestration engine wired to the native worker runner, with the
 * platform-aware limits and budgets read from settings. This is the production
 * construction point: the configured concurrency is narrowed on Android/Termux
 * and the Android process cap is enforced by the engine.
 *
 * When any worker runs isolated, the engine also gets a {@link GitIntegrator}:
 * the branches those workers produce have to land somewhere, and doing it here
 * keeps the merge inside the same run that produced them.
 */
export function createNativeOrchestrationEngine(options: NativeWorkerRunnerOptions): OrchestrationEngine {
	const limits = resolveOrchestratorLimits(options.settings);
	const requestedConcurrency =
		options.concurrency !== undefined ? Math.max(1, Math.trunc(options.concurrency)) : limits.concurrency;
	const concurrency =
		limits.processCap !== undefined
			? Math.min(requestedConcurrency, ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID)
			: requestedConcurrency;
	const runner = new NativeWorkerRunner(options);
	const anyIsolated = options.forceIsolation === true || options.isolateWorkers !== false;

	const allowProjectChecks = cfgOrchestratorAllowProjectVerificationChecks.get(options.settings);
	const checksProvenance = options.settings.getProvenance?.(cfgOrchestratorVerificationChecks);
	const settingsVerificationChecks =
		!allowProjectChecks && checksProvenance === "project"
			? []
			: resolveOrchestratorVerificationChecks(options.settings);
	const verificationChecks =
		options.verificationChecks && options.verificationChecks.length > 0
			? [...options.verificationChecks]
			: settingsVerificationChecks;
	const verifier = verificationChecks.length > 0 ? new ShellVerifier() : undefined;

	const conflictPolicy = cfgOrchestratorConflictResolution.get(options.settings);
	const integratorAgent =
		conflictPolicy === "integrator-agent" && options.agents ? getAgent([...options.agents], "integrator") : undefined;
	const resolveConflict = integratorAgent ? buildIntegratorConflictResolver(options, integratorAgent) : undefined;

	const transport = options.transport ?? (options.session.enableIrc !== false ? new IrcMessageTransport() : undefined);

	return new OrchestrationEngine({
		runner,
		concurrency,
		processCap: limits.processCap,
		maxRetries: options.maxRetries ?? cfgOrchestratorMaxRetries.get(options.settings),
		budget: resolveOrchestratorBudget(options.settings),
		...(transport ? { transport } : {}),
		...(anyIsolated
			? {
					integrator: new GitIntegrator({
						cwd: options.cwd,
						...(resolveConflict ? { resolveConflict } : {}),
					}),
				}
			: {}),
		...(verifier
			? {
					verifier,
					verificationChecks,
					verificationRoot: options.cwd,
					verifyBranch: (root, branchName, checks, signal) =>
						verifyBranchInTempWorktree(root, branchName, checks, verifier, signal),
				}
			: {}),
	});
}
