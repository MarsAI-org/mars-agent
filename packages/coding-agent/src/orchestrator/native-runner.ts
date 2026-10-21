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
 * Tests never use this runner; they inject a fake runner (see
 * `test/orchestrator/engine.test.ts`), so no test reaches a model or the
 * network.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 3, 7, and Milestone 3.
 */

import type { Settings } from "../config/settings";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { AgentDefinition } from "../task/types";
import type { ApprovalMode } from "../tools/approval";
import type { ToolSession } from "../tools";
import { OrchestrationEngine, type EngineRunner, type WorkerRunContext } from "./engine";
import { GitIntegrator } from "./git-integrator";
import { resolveOrchestratorBudget, resolveOrchestratorLimits } from "./settings";
import { requireWorkerSpawn } from "./worker-session";
import type { OrchestratorTask, WorkerChanges, WorkerOutcome, WorkerSpec } from "./types";

export interface NativeWorkerRunnerOptions {
	readonly settings: Settings;
	readonly cwd: string;
	/** Agent definition every worker runs as. */
	readonly agent: AgentDefinition;
	/** Tool names the parent session currently has active. */
	readonly parentActiveTools: readonly string[];
	/** Parent session's approval mode; undefined when unknown. */
	readonly parentApprovalMode?: ApprovalMode;
	/** Nesting depth for the spawned sessions (0 for a top-level orchestrator). */
	readonly taskDepth?: number;
	/** Directory for worker artifacts (patches, outputs). */
	readonly artifactsDir?: string;
	/** Parent agent id, used for registry parentage. */
	readonly parentAgentId?: string;
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

	async run(spec: WorkerSpec, task: OrchestratorTask, context: WorkerRunContext): Promise<WorkerOutcome> {
		const plan = requireWorkerSpawn({
			agent: this.#options.agent,
			parentActiveTools: this.#options.parentActiveTools,
			requestedTools: spec.requestedTools,
			parentApprovalMode: this.#options.parentApprovalMode,
		});
		// The structured pipeline resolves the agent by name from discovery, so the
		// intersected tool set rides a session-local agent definition rather than
		// mutating the shared one. `getSessionAgents` is exactly the hook the
		// pipeline merges over discovered agents.
		const restrictedAgent: AgentDefinition = { ...this.#options.agent, tools: [...plan.tools] };
		const session: ToolSession = {
			...this.#options.session,
			taskDepth: this.#options.taskDepth ?? 0,
			restrictToolNames: true,
			getSessionAgents: () => [restrictedAgent],
		};

		const isolated = this.#shouldIsolate(spec);
		try {
			const execution = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: task.description,
				// Resolve to the restricted definition registered above.
				agent: restrictedAgent.name,
				identity: { id: spec.id, label: spec.roleLabel },
				// The plan already arbitrates ordering through dependencies and file
				// leases, so a worker never needs to recurse into another orchestrator.
				blockedAgent: this.#options.agent.name,
				...(isolated ? { isolation: { requested: true, merge: this.#options.mergeMode ?? "branch" } } : {}),
				signal: context.signal,
			});

			const result = execution.result;
			return {
				exitCode: result.exitCode,
				output: result.output,
				error: result.error,
				usage: { totalTokens: result.tokens, requests: result.requests },
				...(isolated ? { changes: toWorkerChanges(execution) } : {}),
			};
		} catch (error) {
			// A spawn or isolation failure is a task failure, not a reason to abort
			// the whole plan: the engine marks this task failed and cancels its
			// dependents while independent tasks keep running.
			return {
				exitCode: 1,
				output: "",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

/** Project the structured-subagent result onto the orchestrator's change record. */
function toWorkerChanges(execution: Awaited<ReturnType<typeof runStructuredSubagent>>): WorkerChanges {
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
	const runner = new NativeWorkerRunner(options);
	const anyIsolated = options.forceIsolation === true || options.isolateWorkers !== false;
	return new OrchestrationEngine({
		runner,
		concurrency: limits.concurrency,
		processCap: limits.processCap,
		budget: resolveOrchestratorBudget(options.settings),
		...(anyIsolated ? { integrator: new GitIntegrator({ cwd: options.cwd }) } : {}),
	});
}
