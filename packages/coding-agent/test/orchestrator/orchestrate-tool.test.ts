/**
 * `orchestrate` tool contracts (no test spawns a real worker or reaches a model):
 * - a plan with a duplicate/empty id, unknown dependency, unknown worker reference, or cycle is rejected before any worker starts
 * - the plan builder fills worker and agent defaults, preserves per-worker agent/model/tools, and auto-provisions `worker-1..N`
 * - the tool refuses to run while `orchestrator.enabled` is off
 * - `OrchestrateTool.execute()` runs parallel auto-provisioned workers, includes worker output in details and report, handles pre-aborted signals, and flushes trailing board updates
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import type { SingleResult } from "@marsai-org/tui/tools/task";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { clearLiveSwarmRuns, getActiveSwarmRun } from "../../src/orchestrator/run-store";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMode,
} from "../../src/orchestrator/settings";
import type { OrchestratorPlan } from "../../src/orchestrator/types";
import type { ToolSession } from "../../src/sdk";
import * as discoveryModule from "../../src/task/discovery";
import * as structuredSubagentModule from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import { buildPlan, OrchestrateTool, type OrchestrateDetails, validatePlan } from "../../src/tools/orchestrate";

const TEST_AGENT: AgentDefinition = {
	name: "task",
	description: "General worker",
	systemPrompt: "Worker prompt",
	tools: ["read", "grep", "edit", "write"],
	source: "bundled",
};

function planOf(tasks: OrchestratorPlan["tasks"][number][]): OrchestratorPlan {
	return { id: "p", goal: "g", tasks, workers: [{ id: "w", roleLabel: "w", backend: "native", isolated: false }] };
}

function task(id: string, dependencies: string[] = [], agent?: string): OrchestratorPlan["tasks"][number] {
	return {
		id,
		title: id,
		description: id,
		dependencies,
		targetFiles: [],
		...(agent === undefined ? {} : { agent }),
	};
}

function makeToolSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp/mars-orchestrate-tool-test",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		isToolActive: name => name === "read" || name === "grep" || name === "edit" || name === "orchestrate",
	};
}

function makeExecutionResult(
	id: string,
	output: string,
	tokens = 120,
	requests = 1,
): structuredSubagentModule.StructuredSubagentResult {
	const single: SingleResult = {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: output,
		assignment: output,
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens,
		requests,
	};
	return {
		result: single,
		policy: {} as structuredSubagentModule.EffectiveSubagentPolicy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp/mars-orchestrate-artifacts",
		temporaryArtifacts: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	clearLiveSwarmRuns();
	resetSettingsForTest();
});

describe("validatePlan", () => {
	test("accepts a flat plan", () => {
		expect(validatePlan(planOf([task("a"), task("b")]))).toBeUndefined();
	});

	test("accepts a valid dependency chain", () => {
		expect(validatePlan(planOf([task("a"), task("b", ["a"]), task("c", ["b"])]))).toBeUndefined();
	});

	test("rejects an empty task id or empty worker id", () => {
		expect(validatePlan(planOf([task("   ")]))).toContain("Task id cannot be empty");
		expect(
			validatePlan({
				id: "p",
				goal: "g",
				tasks: [task("a")],
				workers: [{ id: "", roleLabel: "w", backend: "native", isolated: false }],
			}),
		).toContain("Worker id cannot be empty");
	});

	test("rejects a duplicate task id or duplicate worker id", () => {
		expect(validatePlan(planOf([task("a"), task("a")]))).toContain("Duplicate task id");
		expect(
			validatePlan({
				id: "p",
				goal: "g",
				tasks: [task("a")],
				workers: [
					{ id: "w1", roleLabel: "w1", backend: "native", isolated: false },
					{ id: "w1", roleLabel: "w2", backend: "native", isolated: false },
				],
			}),
		).toContain("Duplicate worker id");
	});

	test("rejects a task referencing an unknown worker id or roleLabel", () => {
		expect(validatePlan(planOf([task("a", [], "nonexistent-worker")]))).toContain("unknown worker");
	});

	test("rejects a dependency on an unknown task", () => {
		expect(validatePlan(planOf([task("a", ["ghost"])]))).toContain("unknown task");
	});

	test("rejects a self dependency", () => {
		expect(validatePlan(planOf([task("a", ["a"])]))).toContain("itself");
	});

	test("rejects a cycle", () => {
		expect(validatePlan(planOf([task("a", ["b"]), task("b", ["a"])]))).toContain("cycle");
	});

	test("rejects a plan with no workers", () => {
		expect(validatePlan({ id: "p", goal: "g", tasks: [task("a")], workers: [] })).toContain("worker");
	});
});

describe("buildPlan", () => {
	test("fills a default worker when none is supplied", () => {
		const plan = buildPlan({ goal: "do it", tasks: [{ id: "a", title: "A", description: "a" }] });
		expect(plan.workers).toHaveLength(1);
		expect(plan.workers[0]?.id).toBe("worker-1");
		expect(plan.tasks[0]?.dependencies).toEqual([]);
		expect(plan.tasks[0]?.targetFiles).toEqual([]);
	});

	test("auto-provisions worker-1..N bounded by task count and defaultWorkerCount", () => {
		const plan = buildPlan(
			{
				goal: "parallel work",
				tasks: [
					{ id: "t1", title: "T1", description: "first" },
					{ id: "t2", title: "T2", description: "second" },
					{ id: "t3", title: "T3", description: "third" },
				],
			},
			2,
		);
		expect(plan.workers.map(w => w.id)).toEqual(["worker-1", "worker-2"]);
	});

	test("carries explicit workers with agent, model, tools, and per-task agents", () => {
		const plan = buildPlan({
			goal: "do it",
			tasks: [{ id: "a", title: "A", description: "a", agent: "frontend" }],
			workers: [
				{
					id: "frontend",
					roleLabel: "Frontend",
					agent: "scout",
					model: "anthropic/claude-sonnet-4-5",
					tools: ["read", "grep"],
				},
			],
		});
		expect(plan.workers[0]).toMatchObject({
			id: "frontend",
			roleLabel: "Frontend",
			agent: "scout",
			model: "anthropic/claude-sonnet-4-5",
			requestedTools: ["read", "grep"],
		});
		expect(plan.tasks[0]?.agent).toBe("frontend");
	});

	test("defaults workers to the shared checkout", () => {
		const plan = buildPlan({
			goal: "do it",
			tasks: [{ id: "a", title: "A", description: "a" }],
			workers: [{ id: "w" }],
		});
		expect(plan.workers[0]?.isolated).toBe(false);
	});

	test("carries a worker's isolation request through to the plan", () => {
		const plan = buildPlan({
			goal: "do it",
			tasks: [{ id: "a", title: "A", description: "a" }],
			workers: [{ id: "w", isolated: true }],
		});
		expect(plan.workers[0]?.isolated).toBe(true);
	});

	test("preserves declared dependencies and write sets", () => {
		const plan = buildPlan({
			goal: "do it",
			tasks: [
				{ id: "a", title: "A", description: "a", targetFiles: ["src/a.ts"] },
				{ id: "b", title: "B", description: "b", dependencies: ["a"] },
			],
		});
		expect(plan.tasks[0]?.targetFiles).toEqual(["src/a.ts"]);
		expect(plan.tasks[1]?.dependencies).toEqual(["a"]);
	});
});

describe("OrchestrateTool.execute", () => {
	test("refuses to run when orchestrator.enabled is false", async () => {
		const settings = Settings.isolated({});
		const tool = new OrchestrateTool(makeToolSession(settings), [TEST_AGENT]);

		const result = await tool.execute("call-1", {
			goal: "ship feature",
			tasks: [{ id: "t1", title: "Task 1", description: "do t1" }],
		});

		expect(result.details?.error).toBe("orchestrator-disabled");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("orchestrator.enabled"),
		});
	});

	test("auto-provisions worker-1..N, excludes orchestrate from child tools, includes worker output in report/details, and flushes trailing update", async () => {
		const settings = Settings.isolated({});
		cfgOrchestratorEnabled.set(settings, true);
		cfgOrchestratorMaxConcurrency.set(settings, 3);
		cfgOrchestratorMode.set(settings, "parallel");

		const spawnedIds: string[] = [];
		const childToolSets: (readonly string[] | undefined)[] = [];
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			spawnedIds.push(request.identity?.id ?? "unknown");
			const sessionAgents = request.session.getSessionAgents?.() ?? [];
			childToolSets.push(sessionAgents[0]?.tools);
			return makeExecutionResult(
				request.identity?.id ?? "sub",
				`Finished\t${request.identity?.id} in /root/workspace/project`,
			);
		});
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [TEST_AGENT],
			projectAgentsDir: null,
		});

		const tool = await OrchestrateTool.create(makeToolSession(settings));
		const updates: OrchestrateDetails[] = [];
		const result = await tool.execute(
			"call-parallel",
			{
				goal: "run two tasks",
				tasks: [
					{ id: "t1", title: "Task 1", description: "work 1", targetFiles: ["src/a.ts"] },
					{ id: "t2", title: "Task 2", description: "work 2", targetFiles: ["src/b.ts"] },
				],
			},
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);

		expect(spawnedIds.sort()).toEqual(["worker-1-t1", "worker-2-t2"]);
		for (const tools of childToolSets) {
			expect(tools).not.toContain("orchestrate");
			expect(tools).toEqual(["read", "edit", "grep"]);
		}

		expect(result.details?.outcomes).toHaveLength(2);
		expect(result.details?.outcomes?.[0]).toMatchObject({
			taskId: "t1",
			state: "completed",
			workerId: "worker-1",
			exitCode: 0,
			attempts: 1,
			output: "Finished\tworker-1-t1 in /root/workspace/project",
		});
		const reportText = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(reportText).toContain("2/2 tasks completed");
		expect(reportText).toContain("Finished   worker-1-t1");
		expect(reportText).not.toContain("\t");

		// Trailing-edge flush guarantees the final completed pane state is delivered to onUpdate.
		expect(updates.length).toBeGreaterThanOrEqual(2);
		const finalPanes = updates[updates.length - 1]?.panes ?? [];
		expect(finalPanes.map(p => p.state)).toEqual(["completed", "completed"]);

		// Live run registry records the run and marks it inactive after completion.
		const liveRun = getActiveSwarmRun(result.details?.planId);
		expect(liveRun?.isActive()).toBe(false);
	});

	test("handles a pre-aborted signal without spawning any worker", async () => {
		const settings = Settings.isolated({});
		cfgOrchestratorEnabled.set(settings, true);
		const spy = vi.spyOn(structuredSubagentModule, "runStructuredSubagent");

		const controller = new AbortController();
		controller.abort("pre-cancelled");

		const tool = new OrchestrateTool(makeToolSession(settings), [TEST_AGENT]);
		const result = await tool.execute(
			"call-aborted",
			{
				goal: "cancelled plan",
				tasks: [{ id: "t1", title: "Task 1", description: "do t1" }],
			},
			controller.signal,
		);

		expect(spy).not.toHaveBeenCalled();
		expect(result.details?.stoppedReason).toBe("cancelled by caller");
		expect(result.details?.outcomes?.[0]?.state).toBe("cancelled");
	});
});
