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

class ControlledRunner implements EngineRunner {
	readonly starts: string[] = [];

	async run(_spec: WorkerSpec, task: { id: string }, context: WorkerRunContext): Promise<WorkerOutcome> {
		this.starts.push(task.id);
		const gate = Promise.withResolvers<WorkerOutcome>();
		if (context.signal.aborted) {
			gate.resolve({ exitCode: 1, output: "", error: "aborted" });
		} else {
			context.signal.addEventListener(
				"abort",
				() => {
					gate.resolve({ exitCode: 1, output: "", error: "aborted" });
				},
				{ once: true },
			);
		}
		return gate.promise;
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
	test("reads the configured concurrency from settings on desktop", () => {
		const settings = Settings.isolated({ "orchestrator.maxConcurrency": 8 });
		const limits = resolveOrchestratorLimits(settings, { platform: "linux", env: {} });
		expect(limits).toEqual({ concurrency: 8, processCap: undefined });
	});

	test("narrows concurrency and sets the process cap in a Termux environment", () => {
		const limits = resolveOrchestratorLimits(
			Settings.isolated({ "orchestrator.maxConcurrency": 8, "orchestrator.androidProcessCap": 6 }),
			{
				platform: "linux",
				env: {
					PREFIX: "/data/data/com.termux/files/usr",
					TERMUX_VERSION: "0.118.0",
				},
			},
		);
		// Mobile default narrows the configured 8 down to 2, and the cap applies.
		expect(limits).toEqual({ concurrency: 2, processCap: 6 });
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
		const runner = new ControlledRunner();
		// cap 5 => 1 parent + 2 per worker => 2 workers
		const engine = new OrchestrationEngine({ runner, concurrency: 8, processCap: 5 });
		expect(engine.concurrency).toBe(2);

		const runPromise = engine.run(
			plan(["a", "b", "c", "d"], [worker("w1"), worker("w2"), worker("w3"), worker("w4")]),
		);
		while (runner.starts.length < 2) {
			await Bun.sleep(1);
		}
		// Only the capped number of workers may be in flight.
		expect(runner.starts.length).toBe(2);
		engine.stopAll("test done");
		const report = await runPromise;
		expect(report.stoppedReason).toBe("test done");
	});

	test("a cap of 1 slot still allows one worker", () => {
		const engine = new OrchestrationEngine({ runner: new ControlledRunner(), concurrency: 8, processCap: 2 });
		expect(engine.concurrency).toBe(1);
	});

	test("no cap leaves the configured concurrency alone", () => {
		const engine = new OrchestrationEngine({ runner: new ControlledRunner(), concurrency: 3 });
		expect(engine.concurrency).toBe(3);
		expect(engine.processCap).toBeUndefined();
	});
});
