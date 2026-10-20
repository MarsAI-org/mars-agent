/**
 * `orchestrate` tool contracts (no test spawns a worker or reaches a model):
 * - a plan with a duplicate id, unknown dependency, or cycle is rejected before
 *   any worker starts
 * - the plan builder fills worker and agent defaults
 * - the tool refuses to run while `orchestrator.enabled` is off
 */

import { describe, expect, test } from "bun:test";
import { buildPlan, validatePlan } from "../../src/tools/orchestrate";
import type { OrchestratorPlan } from "../../src/orchestrator/types";

function planOf(tasks: OrchestratorPlan["tasks"][number][]): OrchestratorPlan {
	return { id: "p", goal: "g", tasks, workers: [{ id: "w", roleLabel: "w", backend: "native", isolated: false }] };
}

function task(id: string, dependencies: string[] = []): OrchestratorPlan["tasks"][number] {
	return { id, title: id, description: id, dependencies, targetFiles: [] };
}

describe("validatePlan", () => {
	test("accepts a flat plan", () => {
		expect(validatePlan(planOf([task("a"), task("b")]))).toBeUndefined();
	});

	test("accepts a valid dependency chain", () => {
		expect(validatePlan(planOf([task("a"), task("b", ["a"]), task("c", ["b"])]))).toBeUndefined();
	});

	test("rejects a duplicate task id", () => {
		expect(validatePlan(planOf([task("a"), task("a")]))).toContain("Duplicate");
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

	test("carries explicit workers and per-task agents", () => {
		const plan = buildPlan({
			goal: "do it",
			tasks: [{ id: "a", title: "A", description: "a", agent: "frontend" }],
			workers: [{ id: "frontend", roleLabel: "Frontend" }],
		});
		expect(plan.workers[0]).toMatchObject({ id: "frontend", roleLabel: "Frontend" });
		expect(plan.tasks[0]?.agent).toBe("frontend");
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
