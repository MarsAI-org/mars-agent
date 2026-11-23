/**
 * Live pane state for the orchestrator board.
 *
 * The board renders a snapshot; this keeps that snapshot current by folding
 * engine events into one record per worker. Kept out of the board so the board
 * stays a pure function of its input and can be tested without an engine.
 */

import type { PendingIntegration } from "./engine";
import type { PaneState, WorkerPane } from "@marsai-org/tui/apps/orchestrator-board";
import type { OrchestratorEvent, OrchestratorPlan, OrchestratorTask, WorkerLifecycleState, WorkerUsage } from "./types";

/** Map an engine lifecycle state onto the pane vocabulary. */
function toPaneState(state: WorkerLifecycleState): PaneState {
	return state;
}

function isTerminalState(state: PaneState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function usageTotalTokens(usage: WorkerUsage): number {
	if (usage.totalTokens !== undefined) return usage.totalTokens;
	return (
		(usage.inputTokens ?? 0) +
		(usage.outputTokens ?? 0) +
		(usage.reasoningTokens ?? 0) +
		(usage.cacheReadTokens ?? 0) +
		(usage.cacheWriteTokens ?? 0)
	);
}

export class BoardModel {
	readonly #panes = new Map<string, WorkerPane>();
	readonly #tasks = new Map<string, OrchestratorTask>();
	readonly #startedAt = new Map<string, number>();
	readonly #frozenElapsed = new Map<string, number>();
	readonly #activeTaskId = new Map<string, string>();
	readonly #output = new Map<string, string[]>();
	readonly #now: () => number;

	constructor(plan: OrchestratorPlan, now: () => number = Date.now) {
		this.#now = now;
		for (const task of plan.tasks) {
			this.#tasks.set(task.id, task);
		}
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
				const prevTaskId = this.#activeTaskId.get(event.workerId);
				const isNewTask = prevTaskId !== undefined && prevTaskId !== event.taskId;
				const wasTerminal = isTerminalState(pane.state);

				if (event.state === "spawning" && (isNewTask || wasTerminal)) {
					this.#startedAt.delete(event.workerId);
					this.#frozenElapsed.delete(event.workerId);
				} else if (event.state === "running") {
					if (!this.#startedAt.has(event.workerId) || isNewTask || wasTerminal) {
						this.#startedAt.set(event.workerId, this.#now());
					}
					this.#frozenElapsed.delete(event.workerId);
				} else if (isTerminalState(event.state)) {
					const started = this.#startedAt.get(event.workerId);
					if (started !== undefined && !this.#frozenElapsed.has(event.workerId)) {
						this.#frozenElapsed.set(event.workerId, Math.max(0, this.#now() - started));
					}
				}
				this.#activeTaskId.set(event.workerId, event.taskId);
				this.#panes.set(event.workerId, {
					...pane,
					state: toPaneState(event.state),
					taskId: event.taskId,
					...this.#taskMetadata(event.taskId),
					elapsedMs: this.#elapsed(event.workerId),
				});
				return;
			}
			case "task_state": {
				if (!event.workerId) return;
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				this.#panes.set(event.workerId, {
					...pane,
					taskId: event.taskId,
					...this.#taskMetadata(event.taskId),
				});
				return;
			}
			case "worker_output": {
				this.#appendOutput(event.workerId, event.line);
				return;
			}
			case "worker_usage": {
				this.setTokens(event.workerId, usageTotalTokens(event.usage));
				return;
			}
			case "worker_branch": {
				this.setBranch(event.workerId, event.branchName);
				return;
			}
			case "task_retry": {
				const pane = this.#panes.get(event.workerId);
				if (!pane) return;
				this.#panes.set(event.workerId, {
					...pane,
					taskId: event.taskId,
					...this.#taskMetadata(event.taskId),
				});
				this.#appendOutput(event.workerId, `retry ${event.attempt}/${event.maxRetries}: ${event.reason}`);
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
				const started = this.#startedAt.get(event.workerId);
				if (started !== undefined && !this.#frozenElapsed.has(event.workerId)) {
					this.#frozenElapsed.set(event.workerId, Math.max(0, this.#now() - started));
				}
				this.#panes.set(event.workerId, {
					...pane,
					state: event.merged ? "completed" : "failed",
					...(event.merged || event.detail === undefined ? {} : { error: event.detail }),
					elapsedMs: this.#elapsed(event.workerId),
				});
				return;
			}
			case "message": {
				this.#appendOutput(event.message.from, event.message.body);
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
		const annotated = new Set<string>();
		for (const task of plan.tasks) {
			this.#tasks.set(task.id, task);
			const workerId = this.#resolveWorkerId(task.agent);
			if (!workerId || annotated.has(workerId)) continue;
			const pane = this.#panes.get(workerId);
			if (!pane) continue;
			annotated.add(workerId);
			this.#panes.set(workerId, {
				...pane,
				taskId: task.id,
				taskTitle: task.title,
				targetFiles: task.targetFiles,
			});
		}
	}

	#resolveWorkerId(agentOrRole: string | undefined): string | undefined {
		if (!agentOrRole) return undefined;
		if (this.#panes.has(agentOrRole)) return agentOrRole;
		for (const pane of this.#panes.values()) {
			if (pane.label === agentOrRole) return pane.workerId;
		}
		return undefined;
	}

	#taskMetadata(taskId: string): { taskTitle?: string; targetFiles?: readonly string[] } {
		const task = this.#tasks.get(taskId);
		if (!task) return {};
		return {
			taskTitle: task.title,
			targetFiles: task.targetFiles,
		};
	}

	#appendOutput(workerId: string, line: string): void {
		const pane = this.#panes.get(workerId);
		if (!pane) return;
		const lines = this.#output.get(workerId) ?? [];
		// Bound the buffer: the pane only ever shows a tail, and an
		// unbounded array would grow with the whole run.
		lines.push(line);
		if (lines.length > 200) lines.splice(0, lines.length - 200);
		this.#output.set(workerId, lines);
		this.#panes.set(workerId, { ...pane, output: [...lines] });
	}

	#elapsed(workerId: string): number | undefined {
		const frozen = this.#frozenElapsed.get(workerId);
		if (frozen !== undefined) return frozen;
		const started = this.#startedAt.get(workerId);
		return started === undefined ? undefined : this.#now() - started;
	}

	/** The snapshot the board renders. Recomputes elapsed for active workers while keeping terminal timers frozen. */
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
