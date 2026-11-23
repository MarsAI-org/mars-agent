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

export type TaskBoardListener = (event: { taskId: string; from: TaskState; to: TaskState; workerId?: string }) => void;

interface BoardEntry {
	readonly task: OrchestratorTask;
	state: TaskState;
	workerId?: string;
	attempts: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
	pending: new Set<TaskState>(["blocked", "running", "failed", "cancelled"]),
	blocked: new Set<TaskState>(["pending", "running", "failed", "cancelled"]),
	running: new Set<TaskState>(["completed", "failed", "cancelled"]),
	completed: new Set<TaskState>(["failed"]),
	failed: new Set<TaskState>(),
	cancelled: new Set<TaskState>(),
};

export class TaskBoard {
	readonly #entries = new Map<string, BoardEntry>();
	readonly #order: string[] = [];
	readonly #listeners = new Set<TaskBoardListener>();

	/** Insert a task. Ids must be unique within one board. */
	add(task: OrchestratorTask): void {
		this.addTask(task);
	}

	/** Safely add a task (initial or dynamically during a run). */
	addTask(task: OrchestratorTask): void {
		if (!task.id || task.id.trim().length === 0) {
			throw new Error("Task id must be non-empty");
		}
		if (this.#entries.has(task.id)) {
			throw new Error(`Task "${task.id}" is already on the board`);
		}
		if (task.dependencies.includes(task.id)) {
			throw new Error(`Task "${task.id}" cannot depend on itself`);
		}
		this.#entries.set(task.id, { task, state: "pending", attempts: 0 });
		this.#order.push(task.id);
		this.cascadeFailures();
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

	/** Number of execution attempts made for `taskId`. */
	attempts(taskId: string): number {
		return this.#entries.get(taskId)?.attempts ?? 0;
	}

	/** All tasks in insertion order. */
	tasks(): readonly OrchestratorTask[] {
		return this.#order.map(id => this.#entries.get(id)!.task);
	}

	/** All tasks in deterministic dependency-first topological order. */
	topologicalOrder(): OrchestratorTask[] {
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const result: OrchestratorTask[] = [];

		const visit = (id: string): void => {
			if (visited.has(id) || visiting.has(id)) return;
			const entry = this.#entries.get(id);
			if (!entry) return;
			visiting.add(id);
			for (const dep of entry.task.dependencies) {
				visit(dep);
			}
			visiting.delete(id);
			visited.add(id);
			result.push(entry.task);
		};

		for (const id of this.#order) {
			visit(id);
		}
		return result;
	}

	/** Move a task to a new state; returns false for unknown, equal, or invalid transitions. */
	transition(taskId: string, to: TaskState, workerId?: string): boolean {
		const entry = this.#entries.get(taskId);
		if (!entry) return false;
		const from = entry.state;
		if (from === to) return false;
		if (!ALLOWED_TRANSITIONS[from].has(to)) return false;
		if (to === "running") entry.attempts += 1;
		entry.state = to;
		if (workerId !== undefined) entry.workerId = workerId;
		for (const listener of this.#listeners) {
			listener({ taskId, from, to, workerId: entry.workerId });
		}
		if (to === "failed" || to === "cancelled") {
			this.cascadeFailures();
		}
		return true;
	}

	/**
	 * Requeue a running or failed task back to `"pending"` for a retry attempt.
	 * Ensures the prior attempt is counted if the task did not pass through `"running"`.
	 */
	requeueForRetry(taskId: string): boolean {
		const entry = this.#entries.get(taskId);
		if (!entry) return false;
		const from = entry.state;
		if (from !== "running" && from !== "failed") return false;
		if (from !== "running" && entry.attempts === 0) {
			entry.attempts += 1;
		}
		entry.state = "pending";
		for (const listener of this.#listeners) {
			listener({ taskId, from, to: "pending", workerId: entry.workerId });
		}
		return true;
	}

	/**
	 * Transitively mark any `"pending"` or `"blocked"` task as `"cancelled"` when
	 * one of its dependencies on the board has settled as `"failed"` or `"cancelled"`.
	 */
	cascadeFailures(): string[] {
		const cancelled: string[] = [];
		let changed = true;
		while (changed) {
			changed = false;
			for (const id of this.#order) {
				const entry = this.#entries.get(id)!;
				if (entry.state !== "pending" && entry.state !== "blocked") continue;
				const hasFailedDep = entry.task.dependencies.some(dep => {
					const depState = this.#entries.get(dep)?.state;
					return depState === "failed" || depState === "cancelled";
				});
				if (!hasFailedDep) continue;
				const from = entry.state;
				entry.state = "cancelled";
				cancelled.push(id);
				changed = true;
				for (const listener of this.#listeners) {
					listener({ taskId: id, from, to: "cancelled", workerId: entry.workerId });
				}
			}
		}
		return cancelled;
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
