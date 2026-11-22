/**
 * Live pane state for the orchestrator board.
 *
 * The board renders a snapshot; this keeps that snapshot current by folding
 * engine events into one record per worker. Kept out of the board so the board
 * stays a pure function of its input and can be tested without an engine.
 */

import type { PendingIntegration } from "./engine";
import type { PaneState, WorkerPane } from "@marsai-org/tui/apps/orchestrator-board";
import type { OrchestratorEvent, OrchestratorPlan, WorkerLifecycleState } from "./types";

/** Map an engine lifecycle state onto the pane vocabulary. */
function toPaneState(state: WorkerLifecycleState): PaneState {
	return state;
}

export class BoardModel {
	readonly #panes = new Map<string, WorkerPane>();
	readonly #startedAt = new Map<string, number>();
	readonly #output = new Map<string, string[]>();
	readonly #now: () => number;

	constructor(plan: OrchestratorPlan, now: () => number = Date.now) {
		this.#now = now;
		for (const worker of plan.workers) {
			this.#panes.set(worker.id, {
				workerId: worker.id,
				label: worker.roleLabel,
				state: "pending",
			});
		}
	}

	/** Fold one engine event into the snapshot. */
	apply(event: OrchestratorEvent): void {
		switch (event.type) {
			case "worker_state": {
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				if (event.state === "running" && !this.#startedAt.has(event.workerId)) {
					this.#startedAt.set(event.workerId, this.#now());
				}
				this.#panes.set(event.workerId, {
					...pane,
					state: toPaneState(event.state),
					taskId: event.taskId,
					elapsedMs: this.#elapsed(event.workerId),
				});
				return;
			}
			case "task_state": {
				if (!event.workerId) return;
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				this.#panes.set(event.workerId, { ...pane, taskId: event.taskId });
				return;
			}
			case "integration_started": {
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				this.#panes.set(event.workerId, {
					...pane,
					state: "merging",
					...(event.branchName === undefined ? {} : { branchName: event.branchName }),
				});
				return;
			}
			case "integration_finished": {
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				this.#panes.set(event.workerId, {
					...pane,
					state: event.merged ? "completed" : "failed",
					...(event.merged || event.detail === undefined ? {} : { error: event.detail }),
				});
				return;
			}
			case "message": {
				const { from, body } = event.message;
				const pane = this.#panes.get(from);
				if (!pane) return;
				const lines = this.#output.get(from) ?? [];
				// Bound the buffer: the pane only ever shows a tail, and an
				// unbounded array would grow with the whole run.
				lines.push(body);
				if (lines.length > 200) lines.splice(0, lines.length - 200);
				this.#output.set(from, lines);
				this.#panes.set(from, { ...pane, output: [...lines] });
				return;
			}
			default:
				return;
		}
	}

	/** Attach the isolation branch a worker produced, once the engine records it. */
	setBranch(workerId: string, branchName: string): void {
		const pane = this.#panes.get(workerId);
		if (!pane) return;
		this.#panes.set(workerId, { ...pane, branchName });
	}

	/** Attach token accounting reported at settlement. */
	setTokens(workerId: string, tokens: number): void {
		const pane = this.#panes.get(workerId);
		if (!pane) return;
		this.#panes.set(workerId, { ...pane, tokens });
	}

	/** Attach the task title and write set, which the plan knows up front. */
	annotateTasks(plan: OrchestratorPlan): void {
		for (const task of plan.tasks) {
			const workerId = task.agent;
			if (!workerId) continue;
			const pane = this.#panes.get(workerId);
			if (!pane) continue;
			this.#panes.set(workerId, {
				...pane,
				taskTitle: task.title,
				targetFiles: task.targetFiles,
			});
		}
	}

	#elapsed(workerId: string): number | undefined {
		const started = this.#startedAt.get(workerId);
		return started === undefined ? undefined : this.#now() - started;
	}

	/** The snapshot the board renders. Recomputes elapsed so timers tick. */
	snapshot(): readonly WorkerPane[] {
		return [...this.#panes.values()].map(pane => ({ ...pane, elapsedMs: this.#elapsed(pane.workerId) }));
	}

	/** Pending integrations, for a caller that wants to render the merge plan. */
	static pendingFrom(plan: OrchestratorPlan, branches: ReadonlyMap<string, string>): PendingIntegration[] {
		const out: PendingIntegration[] = [];
		for (const task of plan.tasks) {
			const branch = branches.get(task.id);
			if (!branch) continue;
			out.push({
				taskId: task.id,
				workerId: task.agent ?? "unknown",
				branchName: branch,
				targetFiles: task.targetFiles,
			});
		}
		return out;
	}
}
