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

import type { AgentTool, AgentToolResult } from "@marsai-org/agent-core";
import { type } from "@marsai-org/omptype";
import { isRecord, logger, prompt } from "@marsai-org/utils";

import orchestrateDescription from "../prompts/tools/orchestrate.md" with { type: "text" };
import { cfgOrchestratorEnabled } from "../orchestrator/settings";
import { discoverAgents, getAgent } from "../task/discovery";
import { createNativeOrchestrationEngine } from "../orchestrator/native-runner";
import type { OrchestratorPlan, OrchestratorTask, WorkerSpec } from "../orchestrator/types";
import { BUILTIN_TOOL_NAMES } from "./builtin-names";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import type { ToolSession } from "../sdk";

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
		error?: string;
	}>;
	readonly error?: string;
}

/** Build the engine plan from tool arguments, filling worker defaults. */
export function buildPlan(params: OrchestrateParams): OrchestratorPlan {
	const workers: WorkerSpec[] =
		params.workers && params.workers.length > 0
			? params.workers.map(worker => ({
					id: worker.id,
					roleLabel: worker.roleLabel ?? worker.id,
					backend: "native" as const,
					isolated: false,
				}))
			: [
					{
						id: "worker-1",
						roleLabel: "worker-1",
						backend: "native" as const,
						isolated: false,
					},
				];

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
	if (details.planId) lines.push(`Plan ${details.planId}`);
	if (details.stoppedReason) lines.push(`Stopped: ${details.stoppedReason}`);
	const outcomes = details.outcomes ?? [];
	const completed = outcomes.filter(outcome => outcome.state === "completed").length;
	lines.push(`${completed}/${outcomes.length} tasks completed`);
	for (const outcome of outcomes) {
		const mark = outcome.state === "completed" ? "✓" : "✗";
		const detail = outcome.error ? ` — ${outcome.error}` : "";
		lines.push(`  ${mark} ${outcome.taskId}: ${outcome.state}${detail}`);
	}
	if (details.usage) {
		lines.push(`Usage: ${details.usage.totalTokens ?? 0} tokens across ${details.usage.requests ?? 0} request(s)`);
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

	private constructor(
		private readonly session: ToolSession,
		private readonly agents: Awaited<ReturnType<typeof discoverAgents>>["agents"],
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

	/** Tool names currently active in the parent session. */
	#activeToolNames(): string[] {
		const names: string[] = [];
		for (const name of BUILTIN_TOOL_NAMES) {
			if (this.session.isToolActive?.(name) === true) names.push(name);
		}
		return names;
	}

	async execute(
		_toolCallId: string,
		params: OrchestrateParams,
		signal?: AbortSignal,
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

		const plan = buildPlan(params);
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

		const engine = createNativeOrchestrationEngine({
			settings: this.session.settings,
			cwd: this.session.cwd,
			agent,
			parentActiveTools: this.#activeToolNames(),
			taskDepth: (this.session.taskDepth ?? 0) + 1,
			parentAgentId: this.session.getAgentId?.() ?? undefined,
		});

		const onAbort = (): void => engine.stopAll("cancelled by caller");
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			logger.debug("orchestrate tool starting", { goal: plan.goal, tasks: plan.tasks.length });
			const report = await engine.run(plan);
			const details: OrchestrateDetails = {
				planId: report.planId,
				stoppedReason: report.stoppedReason,
				usage: report.usage,
				outcomes: [...report.outcomes].map(([taskId, record]) => ({
					taskId,
					state: record.state,
					workerId: record.workerId,
					exitCode: record.outcome?.exitCode,
					error: record.outcome?.error,
				})),
			};
			return { content: [{ type: "text", text: renderReport(details) }], details };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Orchestration failed: ${message}` }],
				details: { error: message },
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/** Reject plans the engine would only discover after spending budget. */
export function validatePlan(plan: OrchestratorPlan): string | undefined {
	const ids = new Set<string>();
	for (const task of plan.tasks) {
		if (ids.has(task.id)) return `Duplicate task id: ${task.id}`;
		ids.add(task.id);
	}
	for (const task of plan.tasks) {
		for (const dependency of task.dependencies) {
			if (!ids.has(dependency)) return `Task ${task.id} depends on unknown task ${dependency}`;
			if (dependency === task.id) return `Task ${task.id} depends on itself`;
		}
	}
	if (plan.workers.length === 0) return "A plan needs at least one worker";
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
