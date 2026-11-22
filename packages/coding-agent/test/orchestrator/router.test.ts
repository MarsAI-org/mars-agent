/**
 * Router contracts:
 * - small or coupled work never fans out (single agent stays the default)
 * - the fan-out gate needs enough distinct files across enough modules
 * - manual overrides win over the signals
 * - reported reasons name the unmet signals
 */

import { describe, expect, test } from "bun:test";
import {
	countModules,
	decideFanOut,
	DEFAULT_ROUTER_THRESHOLDS,
	type FanOutSignals,
} from "../../src/orchestrator/router";

const baseSignals: FanOutSignals = {
	taskCount: 2,
	independentTaskCount: 2,
	fileTargets: 2,
	moduleCount: 1,
	platform: "desktop",
	estimatedRuntimeMs: 10_000,
};

describe("decideFanOut", () => {
	test("keeps a small single-file change on one agent", () => {
		const decision = decideFanOut(baseSignals);
		expect(decision.fanOut).toBe(false);
		expect(decision.unmet).toContain("fileTargets");
		expect(decision.unmet).toContain("moduleCount");
		expect(decision.unmet).toContain("estimatedRuntimeMs");
	});

	test("fans out only when files, modules, and weight all clear the thresholds", () => {
		const decision = decideFanOut({
			...baseSignals,
			fileTargets: DEFAULT_ROUTER_THRESHOLDS.touchPoints,
			moduleCount: DEFAULT_ROUTER_THRESHOLDS.minModules,
			estimatedRuntimeMs: DEFAULT_ROUTER_THRESHOLDS.minEstimatedRuntimeMs,
		});
		expect(decision.fanOut).toBe(true);
		expect(decision.unmet).toEqual([]);
	});

	test("never fans out with fewer than two independent tasks", () => {
		const decision = decideFanOut({
			...baseSignals,
			taskCount: 3,
			independentTaskCount: 1,
			fileTargets: 10,
			moduleCount: 4,
			estimatedRuntimeMs: 600_000,
		});
		expect(decision.fanOut).toBe(false);
		expect(decision.unmet).toEqual(["independentTaskCount"]);
	});

	test("mode single forces one agent even on a large plan", () => {
		const decision = decideFanOut(
			{
				...baseSignals,
				taskCount: 4,
				independentTaskCount: 4,
				fileTargets: 20,
				moduleCount: 6,
				estimatedRuntimeMs: 900_000,
			},
			{ mode: "single" },
		);
		expect(decision.fanOut).toBe(false);
	});

	test("mode parallel fans out whenever two independent tasks exist", () => {
		const decision = decideFanOut(baseSignals, { mode: "parallel" });
		expect(decision.fanOut).toBe(true);
	});

	test("thresholds are configurable", () => {
		const decision = decideFanOut(baseSignals, {
			thresholds: { touchPoints: 2, minModules: 1, minIndependentTasks: 2, minEstimatedRuntimeMs: 1 },
		});
		expect(decision.fanOut).toBe(true);
	});
});

describe("countModules", () => {
	test("counts distinct top-level directories", () => {
		expect(
			countModules(["packages/tui/src/a.ts", "packages/tui/src/b.ts", "crates/pi-shell/src/c.rs", "root.ts"]),
		).toBe(3);
	});

	test("normalizes windows separators and leading ./", () => {
		expect(countModules(["packages\\tui\\a.ts", "./packages/tui/b.ts"])).toBe(1);
	});
});
