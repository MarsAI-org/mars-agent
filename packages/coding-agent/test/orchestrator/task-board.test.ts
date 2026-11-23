/**
 * Task board contracts:
 * - dependencies gate readiness, and upstream failure cascades cancellation to dependents
 * - state transitions validate legal transitions and notify listeners
 * - ready() preserves insertion order so scheduling is deterministic
 * - dynamic addTask, requeueForRetry, and topologicalOrder maintain DAG invariants
 */

import { describe, expect, test } from "bun:test";
import { TaskBoard } from "../../src/orchestrator/task-board";
import type { OrchestratorTask } from "../../src/orchestrator/types";

function task(id: string, dependencies: readonly string[] = []): OrchestratorTask {
	return { id, title: id, description: `do ${id}`, dependencies, targetFiles: [] };
}

describe("TaskBoard", () => {
	test("holds a dependent task until its dependency completes", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		board.add(task("b", ["a"]));
		expect(board.ready().map(t => t.id)).toEqual(["a"]);
		expect(board.blockedBy("b")).toEqual(["a"]);

		board.transition("a", "running");
		expect(board.ready().map(t => t.id)).toEqual([]);

		board.transition("a", "completed");
		expect(board.ready().map(t => t.id)).toEqual(["b"]);
	});

	test("a task whose dependency failed cascades to cancelled and never becomes ready", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		board.add(task("b", ["a"]));
		board.add(task("c", ["b"]));
		board.transition("a", "failed");
		expect(board.ready().map(t => t.id)).toEqual([]);
		expect(board.blockedBy("b")).toEqual(["a"]);
		expect(board.state("b")).toBe("cancelled");
		expect(board.state("c")).toBe("cancelled");
		expect(board.settled).toBe(true);
	});

	test("validates state transitions and rejects invalid transitions out of terminal states", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		// Cannot jump directly from pending to completed without running.
		expect(board.transition("a", "completed")).toBe(false);
		expect(board.state("a")).toBe("pending");

		expect(board.transition("a", "running", "w1")).toBe(true);
		expect(board.transition("a", "completed")).toBe(true);
		// Cannot return from completed to running or pending.
		expect(board.transition("a", "running")).toBe(false);
		expect(board.transition("a", "pending")).toBe(false);
		// Post-run integration failure can demote completed -> failed, after which failed is terminal.
		expect(board.transition("a", "failed")).toBe(true);
		expect(board.transition("a", "completed")).toBe(false);
		expect(board.transition("a", "cancelled")).toBe(false);
	});

	test("requeueForRetry increments attempts and returns a running or failed task to pending", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		board.transition("a", "running", "w1");
		expect(board.attempts("a")).toBe(1);

		expect(board.requeueForRetry("a")).toBe(true);
		expect(board.state("a")).toBe("pending");
		expect(board.attempts("a")).toBe(1);
		expect(board.ready().map(t => t.id)).toEqual(["a"]);

		board.transition("a", "running", "w1");
		expect(board.attempts("a")).toBe(2);
	});

	test("addTask dynamically inserts tasks and topologicalOrder sorts dependencies before dependents", () => {
		const board = new TaskBoard();
		board.addTask(task("c", ["b"]));
		board.addTask(task("b", ["a"]));
		board.addTask(task("a"));
		expect(board.topologicalOrder().map(t => t.id)).toEqual(["a", "b", "c"]);
		expect(() => board.addTask(task("self", ["self"]))).toThrow(/itself/);
	});

	test("reports ready tasks in insertion order", () => {
		const board = new TaskBoard();
		board.add(task("first"));
		board.add(task("second"));
		board.add(task("third"));
		expect(board.ready().map(t => t.id)).toEqual(["first", "second", "third"]);
	});

	test("counts and transitions reflect terminal states", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		board.add(task("b"));
		board.transition("a", "running", "w1");
		board.transition("a", "completed");
		board.transition("b", "cancelled");
		expect(board.counts()).toMatchObject({ pending: 0, running: 0, completed: 1, cancelled: 1 });
		expect(board.workerOf("a")).toBe("w1");
		expect(board.settled).toBe(true);
	});

	test("notifies subscribers on every transition with workerId", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		const seen: string[] = [];
		const unsubscribe = board.onChange(event =>
			seen.push(`${event.taskId}:${event.from}>${event.to}:${event.workerId ?? ""}`),
		);
		board.transition("a", "running", "w1");
		board.transition("a", "completed");
		unsubscribe();
		board.transition("a", "failed");
		expect(seen).toEqual(["a:pending>running:w1", "a:running>completed:w1"]);
	});

	test("rejects a duplicate task id", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		expect(() => board.add(task("a"))).toThrow(/already on the board/);
	});
});
