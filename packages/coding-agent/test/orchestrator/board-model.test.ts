/**
 * BoardModel folds engine events into pane state.
 *
 * These tests drive it with synthetic events, so they pin the mapping from the
 * engine's vocabulary to what a pane shows — including the cases that used to
 * be invisible (merge phase, isolation branch, failure detail).
 */

import { describe, expect, test } from "bun:test";
import { BoardModel } from "../../src/orchestrator/board-model";
import type { OrchestratorPlan } from "../../src/orchestrator/types";

const PLAN: OrchestratorPlan = {
	id: "p1",
	goal: "ship it",
	workers: [
		{ id: "w1", roleLabel: "frontend", backend: "native", isolated: true },
		{ id: "w2", roleLabel: "backend", backend: "native", isolated: true },
	],
	tasks: [
		{ id: "t1", title: "Build UI", description: "d", dependencies: [], targetFiles: ["src/ui.ts"], agent: "w1" },
		{ id: "t2", title: "Build API", description: "d", dependencies: [], targetFiles: ["src/api.ts"], agent: "w2" },
	],
};

function model(now = () => 1_000): BoardModel {
	const m = new BoardModel(PLAN, now);
	m.annotateTasks(PLAN);
	return m;
}

describe("BoardModel", () => {
	test("starts every worker pending with its role label", () => {
		const panes = model().snapshot();
		expect(panes.map(p => p.label)).toEqual(["frontend", "backend"]);
		expect(panes.every(p => p.state === "pending")).toBe(true);
	});

	test("carries the task title and write set from the plan", () => {
		const panes = model().snapshot();
		expect(panes[0]?.taskTitle).toBe("Build UI");
		expect(panes[0]?.targetFiles).toEqual(["src/ui.ts"]);
	});

	test("a running event starts the elapsed timer", () => {
		let clock = 1_000;
		const m = model(() => clock);
		m.apply({ type: "worker_state", workerId: "w1", taskId: "t1", state: "running" });
		clock = 4_000;
		expect(m.snapshot()[0]?.elapsedMs).toBe(3_000);
	});

	test("the elapsed timer does not restart on a later state change", () => {
		let clock = 1_000;
		const m = model(() => clock);
		m.apply({ type: "worker_state", workerId: "w1", taskId: "t1", state: "running" });
		clock = 2_000;
		m.apply({ type: "worker_state", workerId: "w1", taskId: "t1", state: "verifying" });
		clock = 5_000;
		expect(m.snapshot()[0]?.elapsedMs).toBe(4_000);
	});

	test("an integration event moves the pane to merging and records the branch", () => {
		const m = model();
		m.apply({ type: "integration_started", taskId: "t1", workerId: "w1", branchName: "mars-task-abc" });

		const pane = m.snapshot()[0];
		expect(pane?.state).toBe("merging");
		expect(pane?.branchName).toBe("mars-task-abc");
	});

	test("a successful merge settles the pane completed", () => {
		const m = model();
		m.apply({ type: "integration_started", taskId: "t1", workerId: "w1", branchName: "b" });
		m.apply({ type: "integration_finished", taskId: "t1", workerId: "w1", merged: true });

		expect(m.snapshot()[0]?.state).toBe("completed");
		expect(m.snapshot()[0]?.error).toBeUndefined();
	});

	test("a failed merge surfaces the detail as the pane error", () => {
		const m = model();
		m.apply({
			type: "integration_finished",
			taskId: "t1",
			workerId: "w1",
			merged: false,
			detail: "conflict in src/ui.ts",
		});

		expect(m.snapshot()[0]?.state).toBe("failed");
		expect(m.snapshot()[0]?.error).toBe("conflict in src/ui.ts");
	});

	test("worker output accumulates per worker, not globally", () => {
		const m = model();
		m.apply({
			type: "message",
			message: { id: "m1", from: "w1", to: "all", kind: "status", body: "building ui", ts: 1, status: "sent" },
		});
		m.apply({
			type: "message",
			message: { id: "m2", from: "w2", to: "all", kind: "status", body: "building api", ts: 2, status: "sent" },
		});

		const panes = m.snapshot();
		expect(panes[0]?.output).toEqual(["building ui"]);
		expect(panes[1]?.output).toEqual(["building api"]);
	});

	test("output is bounded so a long run cannot grow without limit", () => {
		const m = model();
		for (let i = 0; i < 500; i++) {
			m.apply({
				type: "message",
				message: { id: `m${i}`, from: "w1", to: "all", kind: "status", body: `line ${i}`, ts: i, status: "sent" },
			});
		}

		const output = m.snapshot()[0]?.output ?? [];
		expect(output.length).toBeLessThanOrEqual(200);
		// The newest line survives the trim.
		expect(output.at(-1)).toBe("line 499");
	});

	test("a message from an unknown sender is ignored rather than creating a pane", () => {
		const m = model();
		m.apply({
			type: "message",
			message: { id: "m1", from: "ghost", to: "all", kind: "status", body: "hi", ts: 1, status: "sent" },
		});
		expect(m.snapshot()).toHaveLength(2);
	});

	test("token accounting lands on the right pane", () => {
		const m = model();
		m.setTokens("w2", 1234);
		const panes = m.snapshot();
		expect(panes[0]?.tokens).toBeUndefined();
		expect(panes[1]?.tokens).toBe(1234);
	});
});
