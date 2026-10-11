/**
 * Native worker runner.
 *
 * The production {@link EngineRunner}: spawns each worker through the existing
 * subagent executor (`runSubprocess`) inside an isolated checkout when
 * requested, with the permission invariant applied to the tool set.
 *
 * Tests never use this runner; they inject a fake runner (see
 * `test/orchestrator/engine.test.ts`), so no test reaches a model or the
 * network.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 3 and 7.
 */

import type { Settings } from "../config/settings";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition } from "../task/types";
import type { ApprovalMode } from "../tools/approval";
import type { EngineRunner, WorkerRunContext } from "./engine";
import { requireWorkerSpawn } from "./worker-session";
import type { OrchestratorTask, WorkerOutcome, WorkerSpec } from "./types";

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
}

export class NativeWorkerRunner implements EngineRunner {
	readonly #options: NativeWorkerRunnerOptions;

	constructor(options: NativeWorkerRunnerOptions) {
		this.#options = options;
	}

	async run(spec: WorkerSpec, task: OrchestratorTask, context: WorkerRunContext): Promise<WorkerOutcome> {
		const plan = requireWorkerSpawn({
			agent: this.#options.agent,
			parentActiveTools: this.#options.parentActiveTools,
			requestedTools: spec.requestedTools,
			parentApprovalMode: this.#options.parentApprovalMode,
		});
		// The executor derives the child tool set from the agent definition, so
		// the intersected set travels as a derived definition plus the
		// restrictToolNames cap.
		const result = await runSubprocess({
			cwd: this.#options.cwd,
			agent: { ...this.#options.agent, tools: [...plan.tools] },
			task: task.description,
			assignment: task.description,
			description: task.title,
			index: 0,
			id: spec.id,
			settings: this.#options.settings,
			taskDepth: this.#options.taskDepth ?? 0,
			parentAgentId: this.#options.parentAgentId,
			restrictToolNames: true,
			artifactsDir: this.#options.artifactsDir,
			// Isolation is applied by the two-phase merge milestone, which owns
			// the isolation runner; this milestone's native spawn is plain.
			modelOverride: spec.model,
			signal: context.signal,
		});
		return {
			exitCode: result.exitCode,
			output: result.output,
			error: result.error,
			usage: { totalTokens: result.tokens, requests: result.requests },
		};
	}
}
