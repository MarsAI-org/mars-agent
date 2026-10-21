/**
 * Orchestration engine.
 *
 * Runs an {@link OrchestratorPlan}: resolves the task DAG, grants file leases,
 * starts workers through the injected runner under a concurrency cap and a
 * budget, and stops the whole run on request. Workers are started through a
 * runner seam so tests use a fake runner and production uses the native
 * subagent runner — no test ever calls a model.
 *
 * Scheduling is deterministic: ready tasks are considered in board insertion
 * order, so the same plan and runner behavior always produce the same start
 * sequence.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 4, 5, and 8.
 */

import { logger } from "@marsai-org/utils";
import { BudgetGuard, type BudgetLimits } from "./budget";
import { FileLeaseManager } from "./lease-manager";
import { OrchestratorMessageLog, type MessageTransport } from "./message-bus";
import { TaskBoard, type TaskBoardListener } from "./task-board";
import { type VerificationCheck, type VerificationResult, type Verifier } from "./verifier";
import type {
	FileLease,
	OrchestratorEvent,
	OrchestratorMessage,
	OrchestratorPlan,
	OrchestratorTask,
	TaskState,
	UsageTotals,
	WorkerLifecycleState,
	WorkerOutcome,
	WorkerSpec,
} from "./types";

/** Context handed to a runner for one worker run. */
export interface WorkerRunContext {
	/** Signal the engine aborts on global stop or budget exhaustion. */
	readonly signal: AbortSignal;
	/** Leases granted for this run. */
	readonly leases: readonly FileLease[];
	/** Send a typed message to a peer worker; the sender id is set by the engine. */
	readonly sendMessage: (
		message: Omit<OrchestratorMessage, "id" | "ts" | "status" | "from">,
	) => Promise<OrchestratorMessage>;
}

/** Runner seam: production spawns subagents, tests supply fakes. */
export interface EngineRunner {
	run(spec: WorkerSpec, task: OrchestratorTask, context: WorkerRunContext): Promise<WorkerOutcome>;
	/** Best-effort cancellation hook; the abort signal in the context is the primary path. */
	cancel?(workerId: string, taskId: string, reason: string): void | Promise<void>;
}

export interface OrchestrationEngineOptions {
	readonly runner: EngineRunner;
	readonly transport?: MessageTransport;
	readonly concurrency?: number;
	/**
	 * Upper bound on the total child process tree (parent host + workers + their
	 * tool children). Android uses this to stay under the platform's
	 * background-process limits; when set it narrows the effective concurrency to
	 * `floor((processCap - 1) / 2)` (one worker plus its tool child per slot).
	 */
	readonly processCap?: number;
	readonly budget?: BudgetLimits;
	readonly now?: () => number;
	/**
	 * Verifier run against a completed worker's tree before the task may settle
	 * as completed. Defaults to a no-op verifier, which keeps the pre-verifier
	 * behaviour for callers that have not configured checks.
	 */
	readonly verifier?: Verifier;
	/** Check list handed to the verifier. Empty means "nothing to verify". */
	readonly verificationChecks?: readonly VerificationCheck[];
	/**
	 * Directory the checks run in, normally the worker's isolation worktree.
	 * Defaults to the process working directory.
	 */
	readonly verificationRoot?: string;
}

/** Outcome record for one task. */
export interface TaskOutcomeRecord {
	readonly state: TaskState;
	readonly workerId?: string;
	readonly outcome?: WorkerOutcome;
}

export interface EngineReport {
	readonly planId: string;
	readonly stoppedReason?: string;
	readonly usage: UsageTotals;
	readonly outcomes: ReadonlyMap<string, TaskOutcomeRecord>;
	readonly messages: readonly OrchestratorMessage[];
}

export type OrchestratorEventListener = (event: OrchestratorEvent) => void;

interface RunningEntry {
	readonly taskId: string;
	readonly workerId: string;
	readonly controller: AbortController;
}

export class OrchestrationEngine {
	readonly #board = new TaskBoard();
	readonly #leases: FileLeaseManager;
	readonly #budget: BudgetGuard;
	readonly #runner: EngineRunner;
	readonly #transport: MessageTransport | undefined;
	readonly #messages = new OrchestratorMessageLog();
	readonly #concurrency: number;
	readonly #processCap: number | undefined;
	readonly #verifier: Verifier | undefined;
	readonly #verificationChecks: readonly VerificationCheck[];
	readonly #verificationRoot: string;
	readonly #listeners = new Set<OrchestratorEventListener>();
	readonly #running = new Map<string, RunningEntry>();
	readonly #settled: Array<{
		taskId: string;
		outcome: WorkerOutcome | undefined;
		error?: string;
		verification?: VerificationResult;
	}> = [];
	#wake: (() => void) | undefined;
	#stopped = false;
	#stoppedReason: string | undefined;
	#started = false;

	constructor(options: OrchestrationEngineOptions) {
		this.#runner = options.runner;
		this.#transport = options.transport;
		const requested = Math.max(1, Math.trunc(options.concurrency ?? 4));
		// A process cap reserves one slot for the parent host and two processes
		// per worker (the worker plus one tool child), so it can narrow the
		// worker count below the configured concurrency.
		const capSlots =
			options.processCap !== undefined && options.processCap > 0
				? Math.max(1, Math.floor((Math.trunc(options.processCap) - 1) / 2))
				: Number.POSITIVE_INFINITY;
		this.#concurrency = Math.max(1, Math.min(requested, capSlots));
		this.#processCap = options.processCap;
		this.#verifier = options.verifier;
		this.#verificationChecks = options.verificationChecks ?? [];
		this.#verificationRoot = options.verificationRoot ?? process.cwd();
		this.#leases = new FileLeaseManager({ now: options.now });
		this.#budget = new BudgetGuard({ ...options.budget, now: options.now });
	}

	/** Effective worker concurrency after the configured cap was applied. */
	get concurrency(): number {
		return this.#concurrency;
	}

	/** The configured child-process ceiling, when one applies (Android/Termux). */
	get processCap(): number | undefined {
		return this.#processCap;
	}

	/** Subscribe to engine events; returns an unsubscribe function. */
	subscribe(listener: OrchestratorEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Stop the whole run: abort running workers and cancel everything pending. */
	stopAll(reason: string): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#stoppedReason = reason;
		for (const entry of [...this.#running.values()]) {
			entry.controller.abort(reason);
			void this.#runner.cancel?.(entry.workerId, entry.taskId, reason);
		}
		this.#notify();
	}

	/** The message log for this run (typed records with delivery status). */
	get messages(): readonly OrchestratorMessage[] {
		return this.#messages.all();
	}

	/**
	 * Run a plan to completion (or to a stop). Resolves with the aggregated
	 * report; never rejects for worker failures — failures are reported in the
	 * report so the caller decides what to do with them.
	 */
	async run(plan: OrchestratorPlan): Promise<EngineReport> {
		if (this.#started) throw new Error("OrchestrationEngine is single-use");
		this.#started = true;
		for (const task of plan.tasks) this.#board.add(task);
		const boardListener: TaskBoardListener = event => {
			this.#emit({ type: "task_state", taskId: event.taskId, from: event.from, to: event.to });
		};
		const unsubscribe = this.#board.onChange(boardListener);
		try {
			this.#emit({
				type: "plan_started",
				planId: plan.id,
				taskCount: plan.tasks.length,
				workerCount: plan.workers.length,
			});
			logger.debug("orchestration run started", {
				planId: plan.id,
				concurrency: this.#concurrency,
				processCap: this.#processCap,
			});
			await this.#schedule(plan);
		} finally {
			unsubscribe();
		}
		const usage = this.#budget.snapshot();
		this.#emit({ type: "plan_finished", planId: plan.id, stoppedReason: this.#stoppedReason, usage });
		logger.debug("orchestration run finished", {
			planId: plan.id,
			stoppedReason: this.#stoppedReason,
			usage,
		});
		return {
			planId: plan.id,
			stoppedReason: this.#stoppedReason,
			usage,
			outcomes: this.#collectOutcomes(),
			messages: this.#messages.all(),
		};
	}

	async #schedule(plan: OrchestratorPlan): Promise<void> {
		while (true) {
			if (this.#stopped) {
				this.#cancelPending();
				await this.#drain();
				return;
			}
			this.#budget.refresh();
			if (this.#budget.exhausted) {
				const reason = this.#budget.reason ?? "budget";
				this.#emit({ type: "budget_exhausted", reason, usage: this.#budget.snapshot() });
				this.stopAll(reason);
				this.#cancelPending();
				await this.#drain();
				return;
			}

			let startable = false;
			for (const task of this.#board.ready()) {
				if (this.#running.size >= this.#concurrency) break;
				if (this.#running.has(task.id)) continue;
				if (this.#startTask(plan, task)) startable = true;
			}
			this.#drainSettled();

			if (this.#running.size === 0) {
				const ready = this.#board.ready();
				// Nothing running: either everything is done, or nothing can ever
				// start (lease-blocked with no live holder, or dependencies that
				// can no longer resolve).
				if (this.#board.settled) return;
				if (ready.length === 0) {
					logger.warn("orchestration stopped: no runnable tasks remain", {
						reason: "unresolvable-dependencies",
					});
					this.#stoppedReason ??= "unresolvable-dependencies";
					this.#cancelPending();
					return;
				}
				if (!startable) {
					logger.warn("orchestration stalled: ready tasks cannot acquire leases", {
						ready: ready.map(task => task.id),
					});
					this.#stoppedReason ??= "lease-stall";
					this.#cancelPending();
					return;
				}
				continue;
			}
			await this.#waitForSettlement();
			this.#drainSettled();
		}
	}

	/** Try to start one task; returns false when leases could not be acquired. */
	#startTask(plan: OrchestratorPlan, task: OrchestratorTask): boolean {
		const spec = this.#workerFor(plan, task);
		if (!spec) {
			logger.warn("orchestration task has no worker; marking failed", { taskId: task.id });
			this.#board.transition(task.id, "failed", undefined);
			return true;
		}
		const requests = task.targetFiles.map(path => ({ path, mode: "write" as const }));
		const leaseResult = this.#leases.acquire(spec.id, requests);
		if (!leaseResult.granted) {
			// Leave the task pending; the holder's completion retries it.
			this.#emit({
				type: "worker_state",
				workerId: spec.id,
				taskId: task.id,
				state: "pending" satisfies WorkerLifecycleState,
			});
			return false;
		}
		const controller = new AbortController();
		this.#board.transition(task.id, "running", spec.id);
		this.#running.set(task.id, { taskId: task.id, workerId: spec.id, controller });
		this.#emit({ type: "worker_state", workerId: spec.id, taskId: task.id, state: "spawning" });
		this.#emit({
			type: "leases_granted",
			taskId: task.id,
			workerId: spec.id,
			paths: leaseResult.leases.map(lease => lease.path),
		});
		void this.#runWorker(plan, spec, task, controller, leaseResult.leases);
		return true;
	}

	async #runWorker(
		plan: OrchestratorPlan,
		spec: WorkerSpec,
		task: OrchestratorTask,
		controller: AbortController,
		leases: readonly FileLease[],
	): Promise<void> {
		this.#emit({ type: "worker_state", workerId: spec.id, taskId: task.id, state: "running" });
		try {
			const outcome = await this.#runner.run(spec, task, {
				signal: controller.signal,
				leases,
				sendMessage: async message => {
					const record = await this.#messages.send(
						{ ...message, from: spec.id },
						this.#transport ?? new LoggingTransport(),
					);
					this.#emit({ type: "message", message: record });
					return record;
				},
			});
			const verification = await this.#verifyOutcome(task, outcome);
			this.#settled.push({ taskId: task.id, outcome, verification });
			this.#emit({
				type: "worker_state",
				workerId: spec.id,
				taskId: task.id,
				state: verification && !verification.ok ? "failed" : "completed",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("orchestration worker failed", { taskId: task.id, workerId: spec.id, message });
			this.#settled.push({ taskId: task.id, outcome: undefined, error: message });
			this.#emit({
				type: "worker_state",
				workerId: spec.id,
				taskId: task.id,
				state: controller.signal.aborted ? "cancelled" : "failed",
			});
		} finally {
			this.#running.delete(task.id);
			this.#leases.release(spec.id);
			this.#notify();
		}
	}

	/**
	 * Run the configured checks against a worker's output.
	 *
	 * Only a worker that exited zero is verified: a failed worker already has a
	 * failure to report, and running checks on a tree it did not finish writing
	 * would produce misleading diagnostics. An aborted run is skipped for the
	 * same reason.
	 */
	async #verifyOutcome(task: OrchestratorTask, outcome: WorkerOutcome): Promise<VerificationResult | undefined> {
		if (!this.#verifier) return undefined;
		if (this.#verificationChecks.length === 0) return undefined;
		if (outcome.exitCode !== 0) return undefined;
		this.#emit({
			type: "worker_state",
			workerId: this.#board.workerOf(task.id) ?? task.id,
			taskId: task.id,
			state: "verifying" satisfies WorkerLifecycleState,
		});
		const result = await this.#verifier.verify(this.#verificationRoot, this.#verificationChecks);
		logger.debug("orchestration verification finished", {
			taskId: task.id,
			ok: result.ok,
			firstFailure: result.firstFailure,
		});
		return result;
	}

	/** Move settled worker runs onto the board and charge the budget. */
	#drainSettled(): void {
		while (this.#settled.length > 0) {
			const settled = this.#settled.shift()!;
			if (settled.outcome) this.#budget.charge(settled.outcome.usage ?? {});
			const state: TaskState = settled.error
				? "failed"
				: settled.verification && !settled.verification.ok
					? "failed"
					: settled.outcome && settled.outcome.exitCode === 0
						? "completed"
						: "failed";
			this.#board.transition(settled.taskId, state);
		}
	}

	#cancelPending(): void {
		for (const task of this.#board.tasks()) {
			const state = this.#board.state(task.id);
			if (state === "pending" || state === "blocked") {
				this.#board.transition(task.id, "cancelled");
			}
		}
	}

	/** Wait for all in-flight workers to settle after a stop. */
	async #drain(): Promise<void> {
		while (this.#running.size > 0) {
			await this.#waitForSettlement();
			this.#drainSettled();
		}
	}

	#collectOutcomes(): Map<string, TaskOutcomeRecord> {
		const outcomes = new Map<string, TaskOutcomeRecord>();
		for (const task of this.#board.tasks()) {
			const state = this.#board.state(task.id);
			if (!state) continue;
			outcomes.set(task.id, { state, workerId: this.#board.workerOf(task.id) });
		}
		for (const settled of this.#settled) {
			const record = outcomes.get(settled.taskId);
			if (record) outcomes.set(settled.taskId, { ...record, outcome: settled.outcome });
		}
		return outcomes;
	}

	#workerFor(plan: OrchestratorPlan, task: OrchestratorTask): WorkerSpec | undefined {
		if (task.agent) {
			const byId = plan.workers.find(worker => worker.id === task.agent);
			if (byId) return byId;
			const byRole = plan.workers.find(worker => worker.roleLabel === task.agent);
			if (byRole) return byRole;
		}
		// Without an explicit agent, prefer a worker that holds no lease, so two
		// tasks that write the same file land on two different workers and the
		// lease manager can serialize them instead of letting one worker hold both.
		const busy = new Set(this.#leases.activeWorkers());
		const free = plan.workers.find(worker => !busy.has(worker.id));
		return free ?? plan.workers[0];
	}

	#waitForSettlement(): Promise<void> {
		return new Promise<void>(resolve => {
			this.#wake = resolve;
		});
	}

	#notify(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#emit(event: OrchestratorEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
}

/** Transport used when none is injected: keeps a local record and drops delivery. */
class LoggingTransport implements MessageTransport {
	async send(): Promise<{ delivered: boolean; error?: string }> {
		return { delivered: false, error: "no message transport configured" };
	}
}
