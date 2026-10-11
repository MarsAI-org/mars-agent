/**
 * Task board contracts:
 * - dependencies gate readiness, and a task whose dependency failed never runs
 * - state transitions notify listeners (the UI subscribes to these)
 * - ready() preserves insertion order so scheduling is deterministic
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

	test("a task whose dependency failed never becomes ready", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		board.add(task("b", ["a"]));
		board.transition("a", "failed");
		expect(board.ready().map(t => t.id)).toEqual([]);
		expect(board.blockedBy("b")).toEqual(["a"]);
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

	test("notifies subscribers on every transition", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		const seen: string[] = [];
		const unsubscribe = board.onChange(event => seen.push(`${event.taskId}:${event.from}>${event.to}`));
		board.transition("a", "running");
		board.transition("a", "completed");
		unsubscribe();
		board.transition("a", "failed"); // already terminal; no-op anyway
		expect(seen).toEqual(["a:pending>running", "a:running>completed"]);
	});

	test("rejects a duplicate task id", () => {
		const board = new TaskBoard();
		board.add(task("a"));
		expect(() => board.add(task("a"))).toThrow(/already on the board/);
	});
});
