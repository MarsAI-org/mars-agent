/**
 * Platform-aware orchestration limit contracts:
 * - limits are read from settings (not passed through)
 * - the Android process cap is enforced by the engine, narrowing concurrency to
 *   fit the cap (parent host + worker + one tool child per slot)
 * - budget settings document `0` as unlimited and reach the engine as "no limit"
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { OrchestrationEngine, type EngineRunner, type WorkerRunContext } from "../../src/orchestrator/engine";
import { resolveOrchestratorBudget, resolveOrchestratorLimits } from "../../src/orchestrator/settings";
import type { OrchestratorPlan, WorkerOutcome, WorkerSpec } from "../../src/orchestrator/types";

class NeverFinishingRunner implements EngineRunner {
	readonly starts: string[] = [];
	async run(_spec: WorkerSpec, task: { id: string }, _context: WorkerRunContext): Promise<WorkerOutcome> {
		this.starts.push(task.id);
		return new Promise<WorkerOutcome>(() => {});
	}
}

function worker(id: string): WorkerSpec {
	return { id, roleLabel: id, backend: "native", isolated: false };
}

function plan(tasks: readonly string[], workers: readonly WorkerSpec[]): OrchestratorPlan {
	return {
		id: "p",
		goal: "g",
		workers,
		tasks: tasks.map(id => ({ id, title: id, description: id, dependencies: [], targetFiles: [] })),
	};
}

describe("resolveOrchestratorLimits", () => {
	test("reads the configured concurrency from settings", () => {
		const settings = Settings.isolated({ "orchestrator.maxConcurrency": 8 });
		// Non-Android hosts keep the configured value unchanged.
		const expected = process.platform === "android" ? 2 : 8;
		expect(resolveOrchestratorLimits(settings).concurrency).toBe(expected);
	});

	test("reports no process cap on non-Android platforms", () => {
		const settings = Settings.isolated({});
		if (process.platform === "android") return;
		expect(resolveOrchestratorLimits(settings).processCap).toBeUndefined();
	});
});

describe("resolveOrchestratorBudget", () => {
	test("maps 0 (documented unlimited) to no limit", () => {
		const settings = Settings.isolated({
			"orchestrator.maxTokens": 0,
			"orchestrator.maxRequests": 0,
			"orchestrator.maxWallClockMs": 0,
		});
		expect(resolveOrchestratorBudget(settings)).toEqual({
			maxTokens: undefined,
			maxRequests: undefined,
			maxWallClockMs: undefined,
		});
	});

	test("passes positive limits through", () => {
		const settings = Settings.isolated({
			"orchestrator.maxTokens": 500000,
			"orchestrator.maxRequests": 50,
		});
		expect(resolveOrchestratorBudget(settings)).toEqual({
			maxTokens: 500000,
			maxRequests: 50,
			maxWallClockMs: undefined,
		});
	});
});

describe("engine process cap", () => {
	test("narrows concurrency so the process tree fits the cap", async () => {
		const runner = new NeverFinishingRunner();
		// cap 5 => 1 parent + 2 per worker => 2 workers
		const engine = new OrchestrationEngine({ runner, concurrency: 8, processCap: 5 });
		expect(engine.concurrency).toBe(2);

		void engine.run(plan(["a", "b", "c", "d"], [worker("w1"), worker("w2"), worker("w3"), worker("w4")]));
		await new Promise(resolve => setTimeout(resolve, 20));
		// Only the capped number of workers may be in flight.
		expect(runner.starts.length).toBe(2);
		engine.stopAll("test done");
	});

	test("a cap of 1 slot still allows one worker", () => {
		const engine = new OrchestrationEngine({ runner: new NeverFinishingRunner(), concurrency: 8, processCap: 2 });
		expect(engine.concurrency).toBe(1);
	});

	test("no cap leaves the configured concurrency alone", () => {
		const engine = new OrchestrationEngine({ runner: new NeverFinishingRunner(), concurrency: 3 });
		expect(engine.concurrency).toBe(3);
		expect(engine.processCap).toBeUndefined();
	});
});
