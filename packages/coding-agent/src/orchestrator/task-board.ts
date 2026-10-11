/**
 * Shared task board.
 *
 * Holds every task of a plan, tracks its state, and computes which tasks are
 * ready to run (all dependencies completed). Ordering is insertion order so a
 * scheduler consuming `ready()` is deterministic: the same plan always yields
 * the same start sequence, which is what the deterministic scheduling tests
 * assert.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 4 and 5.
 */

import type { OrchestratorTask, TaskState } from "./types";

export type TaskBoardListener = (event: { taskId: string; from: TaskState; to: TaskState }) => void;

interface BoardEntry {
	readonly task: OrchestratorTask;
	state: TaskState;
	workerId?: string;
	attempts: number;
}

export class TaskBoard {
	readonly #entries = new Map<string, BoardEntry>();
	readonly #order: string[] = [];
	readonly #listeners = new Set<TaskBoardListener>();

	/** Insert a task. Ids must be unique within one board. */
	add(task: OrchestratorTask): void {
		if (this.#entries.has(task.id)) {
			throw new Error(`Task "${task.id}" is already on the board`);
		}
		this.#entries.set(task.id, { task, state: "pending", attempts: 0 });
		this.#order.push(task.id);
	}

	get(taskId: string): OrchestratorTask | undefined {
		return this.#entries.get(taskId)?.task;
	}

	state(taskId: string): TaskState | undefined {
		return this.#entries.get(taskId)?.state;
	}

	workerOf(taskId: string): string | undefined {
		return this.#entries.get(taskId)?.workerId;
	}

	/** All tasks in insertion order. */
	tasks(): readonly OrchestratorTask[] {
		return this.#order.map(id => this.#entries.get(id)!.task);
	}

	/** Move a task to a new state; returns false for unknown or equal states. */
	transition(taskId: string, to: TaskState, workerId?: string): boolean {
		const entry = this.#entries.get(taskId);
		if (!entry) return false;
		const from = entry.state;
		if (from === to) return false;
		if (to === "running") entry.attempts += 1;
		entry.state = to;
		if (workerId !== undefined) entry.workerId = workerId;
		for (const listener of this.#listeners) listener({ taskId, from, to });
		return true;
	}

	/** Dependencies of `taskId` that are not completed yet. */
	blockedBy(taskId: string): readonly string[] {
		const entry = this.#entries.get(taskId);
		if (!entry) return [];
		return entry.task.dependencies.filter(dep => {
			const depState = this.#entries.get(dep)?.state;
			return depState !== "completed";
		});
	}

	/**
	 * Tasks that may start now: pending, not blocked, not terminal. Insertion
	 * order is preserved so scheduling is deterministic.
	 */
	ready(): readonly OrchestratorTask[] {
		const ready: OrchestratorTask[] = [];
		for (const id of this.#order) {
			const entry = this.#entries.get(id)!;
			if (entry.state !== "pending") continue;
			if (this.blockedBy(id).length > 0) continue;
			ready.push(entry.task);
		}
		return ready;
	}

	/** True when every task reached a terminal state. */
	get settled(): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.state === "pending" || entry.state === "running" || entry.state === "blocked") return false;
		}
		return true;
	}

	/** Count per state, for status lines. */
	counts(): Record<TaskState, number> {
		const counts: Record<TaskState, number> = {
			pending: 0,
			blocked: 0,
			running: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
		};
		for (const entry of this.#entries.values()) counts[entry.state] += 1;
		return counts;
	}

	onChange(listener: TaskBoardListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
}
