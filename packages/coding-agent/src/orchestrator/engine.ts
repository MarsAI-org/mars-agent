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
	WorkerChanges,
	WorkerLifecycleState,
	WorkerOutcome,
	WorkerSpec,
	WorkerUsage,
} from "./types";

/** Live progress update reported by a running worker. */
export interface WorkerProgressUpdate {
	readonly outputLine?: string;
	readonly usage?: WorkerUsage;
	readonly branchName?: string;
}

/** Context handed to a runner for one worker run. */
export interface WorkerRunContext {
	/** Signal the engine aborts on global stop or budget exhaustion. */
	readonly signal: AbortSignal;
	/** Leases granted for this run. */
	readonly leases: readonly FileLease[];
	/** 1-based execution attempt number for this task (1 on initial run, 2 on first retry, etc.). */
	readonly attempt: number;
	/** Diagnostic feedback from a prior failed verification attempt, when retrying. */
	readonly retryFeedback?: string;
	/** Live telemetry callback for streaming output, usage, and branch updates. */
	readonly reportProgress?: (update: WorkerProgressUpdate) => void;
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

/** One worker branch the integrator has to land. */
export interface PendingIntegration {
	readonly taskId: string;
	readonly workerId: string;
	readonly branchName: string;
	/** Base revision the branch was cut from, for the cherry-pick range. */
	readonly baseSha?: string;
	/** Files the task declared it would write; the integrator reads them as the review surface. */
	readonly targetFiles: readonly string[];
}

/**
 * Integrates finished worker branches into the parent checkout.
 *
 * Kept as a seam so the engine never imports git: production wires an
 * integrator-agent runner, tests inject a fake that records the request.
 */
export interface Integrator {
	/**
	 * Land `pending` in dependency order. Returns the tasks whose branch made it
	 * onto the target, and a human summary for the report.
	 */
	integrate(pending: readonly PendingIntegration[], signal: AbortSignal): Promise<IntegrationReport>;
}

export interface IntegrationReport {
	/** Branch names that landed on the target. */
	readonly merged: readonly string[];
	/** Branch names that did not land (conflict, or never attempted). */
	readonly failed: readonly string[];
	/** Free-form summary from the integrator (conflicts hit, checks run). */
	readonly summary?: string;
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
	 * Maximum verification-failure retries per task before marking the task failed.
	 * Defaults to 0 (no automatic retries unless configured).
	 */
	readonly maxRetries?: number;
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
	/**
	 * Optional branch verification hook. When provided and an isolated worker
	 * produces `changes.branchName` without a live `worktreePath`, checks run
	 * against a checkout of `branchName` rather than the untouched parent `cwd`.
	 */
	readonly verifyBranch?: (
		root: string,
		branchName: string,
		checks: readonly VerificationCheck[],
		signal: AbortSignal,
	) => Promise<VerificationResult>;
	/**
	 * Lands worker branches after the plan settles. Omitted means workers ran in
	 * the shared checkout (or the caller merges on its own), so the engine never
	 * touches git.
	 */
	readonly integrator?: Integrator;
}

/** Outcome record for one task. */
export interface TaskOutcomeRecord {
	readonly state: TaskState;
	readonly workerId?: string;
	readonly outcome?: WorkerOutcome;
	/** Number of execution attempts made for this task. */
	readonly attempts?: number;
	/**
	 * Why the run produced no worker outcome (an engine-side throw or integration
	 * failure). Without it the record said only `failed`, leaving a caller unable
	 * to tell a crashed worker from one that was rejected.
	 */
	readonly error?: string;
	/**
	 * The verification verdict, when checks ran. A `failed` state carrying a
	 * verification is a rejected output, and the failing check's output is the
	 * diagnostic the caller needs to act on.
	 */
	readonly verification?: VerificationResult;
}

export interface EngineReport {
	readonly planId: string;
	readonly stoppedReason?: string;
	readonly usage: UsageTotals;
	readonly outcomes: ReadonlyMap<string, TaskOutcomeRecord>;
	readonly messages: readonly OrchestratorMessage[];
}

export type OrchestratorEventListener = (event: OrchestratorEvent) => void;

/** One task's settlement record, kept until the scheduler consumes it. */
interface SettledRecord {
	readonly taskId: string;
	readonly outcome: WorkerOutcome | undefined;
	readonly error?: string;
	readonly verification?: VerificationResult;
	readonly cancelled?: boolean;
}

interface RunningEntry {
	readonly taskId: string;
	readonly workerId: string;
	readonly controller: AbortController;
}

type WorkerResolution =
	| { readonly kind: "ready"; readonly spec: WorkerSpec }
	| { readonly kind: "busy" }
	| { readonly kind: "none" };

type AbortableVerifier = {
	verify(root: string, checks: readonly VerificationCheck[], signal?: AbortSignal): Promise<VerificationResult>;
};

/** Transport used when none is injected: keeps a local record and drops delivery. */
class LoggingTransport implements MessageTransport {
	async send(): Promise<{ delivered: boolean; error?: string }> {
		return { delivered: false, error: "no message transport configured" };
	}
}

const DEFAULT_LOGGING_TRANSPORT = new LoggingTransport();

export class OrchestrationEngine {
	readonly #board = new TaskBoard();
	readonly #leases: FileLeaseManager;
	readonly #budget: BudgetGuard;
	readonly #runner: EngineRunner;
	readonly #transport: MessageTransport;
	readonly #messages = new OrchestratorMessageLog();
	readonly #concurrency: number;
	readonly #processCap: number | undefined;
	readonly #maxRetries: number;
	readonly #verifier: Verifier | undefined;
	readonly #verificationChecks: readonly VerificationCheck[];
	readonly #verificationRoot: string;
	readonly #verifyBranch:
		| ((
				root: string,
				branchName: string,
				checks: readonly VerificationCheck[],
				signal: AbortSignal,
		  ) => Promise<VerificationResult>)
		| undefined;
	readonly #integrator: Integrator | undefined;
	readonly #listeners = new Set<OrchestratorEventListener>();
	readonly #running = new Map<string, RunningEntry>();
	readonly #busyWorkers = new Set<string>();
	readonly #settled: SettledRecord[] = [];
	/**
	 * Settlement records by task, retained for the final report.
	 *
	 * `#settled` is a queue the scheduler drains, so reading it at report time
	 * found it empty: every run reported `{state, workerId}` and dropped the
	 * worker's output, error, and verification verdict. This map is written at
	 * settlement and never drained.
	 */
	readonly #settledRecords = new Map<string, SettledRecord>();
	/**
	 * Isolation artifacts per task, kept after `#settled` drains: the integration
	 * phase runs once at the end (or incrementally before dependent tasks), long
	 * after each task's settlement record was consumed by the scheduler.
	 */
	readonly #changes = new Map<string, { workerId: string; changes: WorkerChanges }>();
	readonly #integratedTasks = new Set<string>();
	readonly #retryFeedback = new Map<string, string>();
	#integrationController: AbortController | undefined;
	#wake: (() => void) | undefined;
	#notified = false;
	#stopped = false;
	#stoppedReason: string | undefined;
	#budgetExhaustedEmitted = false;
	#started = false;

	constructor(options: OrchestrationEngineOptions) {
		this.#runner = options.runner;
		this.#transport = options.transport ?? DEFAULT_LOGGING_TRANSPORT;
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
		this.#maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 0));
		this.#verifier = options.verifier;
		this.#verificationChecks = options.verificationChecks ?? [];
		this.#verificationRoot = options.verificationRoot ?? process.cwd();
		this.#verifyBranch = options.verifyBranch;
		this.#integrator = options.integrator;
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

	/** Dynamically add a task to the board before or during a run. */
	addTask(task: OrchestratorTask): void {
		this.#board.addTask(task);
		if (this.#started && !this.#stopped) {
			this.#notify();
		}
	}

	/**
	 * Cancel the task currently running on `workerId`, freeing the worker and its
	 * leases without stopping the entire orchestration plan. Returns true if an
	 * active task on `workerId` was found and aborted.
	 */
	cancelWorker(workerId: string, reason = "worker cancelled"): boolean {
		for (const entry of this.#running.values()) {
			if (entry.workerId !== workerId) continue;
			entry.controller.abort(reason);
			this.#invokeRunnerCancel(entry.workerId, entry.taskId, reason);
			this.#notify();
			return true;
		}
		return false;
	}

	/** Stop the whole run: abort running workers and cancel everything pending. */
	stopAll(reason: string): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#stoppedReason = reason;
		this.#integrationController?.abort(reason);
		for (const entry of this.#running.values()) {
			entry.controller.abort(reason);
			this.#invokeRunnerCancel(entry.workerId, entry.taskId, reason);
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
		for (const task of plan.tasks) {
			if (!this.#board.get(task.id)) {
				this.#board.addTask(task);
			}
		}
		const boardListener: TaskBoardListener = event => {
			this.#emit({
				type: "task_state",
				taskId: event.taskId,
				from: event.from,
				to: event.to,
				...(event.workerId === undefined ? {} : { workerId: event.workerId }),
			});
		};
		const unsubscribe = this.#board.onChange(boardListener);
		try {
			this.#emit({
				type: "plan_started",
				planId: plan.id,
				taskCount: this.#board.tasks().length,
				workerCount: plan.workers.length,
			});
			logger.debug("orchestration run started", {
				planId: plan.id,
				concurrency: this.#concurrency,
				processCap: this.#processCap,
			});
			await this.#schedule(plan);
			if (!this.#stopped) {
				await this.#integrate(plan);
			}
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
				this.#emitBudgetExhaustedOnce(reason);
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
			if (!this.#stopped) {
				await this.#integrateForPendingDependents();
				this.#drainSettled();
			}

			if (this.#running.size === 0) {
				this.#drainSettled();
				if (this.#notified) {
					this.#notified = false;
					continue;
				}
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
			if (!this.#stopped) {
				await this.#integrateForPendingDependents();
				this.#drainSettled();
			}
		}
	}

	/** Try to start one task; returns false when leases or worker slot could not be acquired. */
	#startTask(plan: OrchestratorPlan, task: OrchestratorTask): boolean {
		const resolution = this.#workerFor(plan, task);
		if (resolution.kind === "none") {
			logger.warn("orchestration task has no worker; marking failed", { taskId: task.id });
			this.#board.transition(task.id, "failed", undefined);
			return true;
		}
		if (resolution.kind === "busy") {
			return false;
		}
		const spec = resolution.spec;
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
		this.#busyWorkers.add(spec.id);
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
		const attempt = Math.max(1, this.#board.attempts(task.id));
		const retryFeedback = this.#retryFeedback.get(task.id) ?? task.retryFeedback;
		const taskWithFeedback: OrchestratorTask = retryFeedback !== undefined ? { ...task, retryFeedback } : task;
		try {
			const outcome = await this.#runner.run(spec, taskWithFeedback, {
				signal: controller.signal,
				leases,
				attempt,
				...(retryFeedback === undefined ? {} : { retryFeedback }),
				reportProgress: update => {
					if (update.outputLine !== undefined) {
						this.#emit({
							type: "worker_output",
							workerId: spec.id,
							taskId: task.id,
							line: update.outputLine,
						});
					}
					if (update.branchName !== undefined) {
						this.#emit({
							type: "worker_branch",
							workerId: spec.id,
							taskId: task.id,
							branchName: update.branchName,
						});
					}
					if (update.usage !== undefined) {
						this.#budget.recordInterimUsage(task.id, update.usage);
						this.#emit({
							type: "worker_usage",
							workerId: spec.id,
							taskId: task.id,
							usage: update.usage,
						});
						if (this.#budget.exhausted && !this.#stopped) {
							const reason = this.#budget.reason ?? "budget";
							this.#emitBudgetExhaustedOnce(reason);
							this.stopAll(reason);
						}
					}
				},
				sendMessage: async message => {
					const record = await this.#messages.send({ ...message, from: spec.id }, this.#transport);
					this.#emit({ type: "message", message: record });
					return record;
				},
			});

			if (outcome.usage) {
				this.#emit({
					type: "worker_usage",
					workerId: spec.id,
					taskId: task.id,
					usage: outcome.usage,
				});
			}
			if (outcome.changes?.branchName) {
				this.#emit({
					type: "worker_branch",
					workerId: spec.id,
					taskId: task.id,
					branchName: outcome.changes.branchName,
				});
			}

			if (controller.signal.aborted) {
				this.#settled.push({ taskId: task.id, outcome, cancelled: true });
				this.#emit({
					type: "worker_state",
					workerId: spec.id,
					taskId: task.id,
					state: "cancelled",
				});
				return;
			}

			const verification = await this.#verifyOutcome(spec, task, outcome, controller.signal);
			if (controller.signal.aborted) {
				this.#settled.push({ taskId: task.id, outcome, verification, cancelled: true });
				this.#emit({
					type: "worker_state",
					workerId: spec.id,
					taskId: task.id,
					state: "cancelled",
				});
				return;
			}

			const maxRetries = Math.max(0, Math.trunc(task.maxRetries ?? plan.maxRetries ?? this.#maxRetries));
			if (verification && !verification.ok && attempt <= maxRetries && !this.#stopped && !this.#budget.exhausted) {
				if (outcome.usage) {
					this.#budget.charge(outcome.usage, task.id);
				}
				this.#budget.refresh();
				if (!this.#budget.exhausted && !this.#stopped) {
					const reason = formatVerificationFailureFeedback(verification);
					this.#retryFeedback.set(task.id, reason);
					this.#changes.delete(task.id);
					this.#emit({
						type: "task_retry",
						taskId: task.id,
						workerId: spec.id,
						attempt,
						maxRetries,
						reason,
					});
					this.#board.requeueForRetry(task.id);
					this.#emit({
						type: "worker_state",
						workerId: spec.id,
						taskId: task.id,
						state: "pending",
					});
					return;
				}
			}

			if (outcome.changes) {
				this.#changes.set(task.id, { workerId: spec.id, changes: outcome.changes });
			}
			const succeeded = outcome.exitCode === 0 && (!verification || verification.ok);
			this.#settled.push({ taskId: task.id, outcome, verification });
			this.#emit({
				type: "worker_state",
				workerId: spec.id,
				taskId: task.id,
				state: succeeded ? "completed" : "failed",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("orchestration worker failed", { taskId: task.id, workerId: spec.id, message });
			const aborted = controller.signal.aborted;
			this.#settled.push({
				taskId: task.id,
				outcome: undefined,
				error: message,
				...(aborted ? { cancelled: true } : {}),
			});
			this.#emit({
				type: "worker_state",
				workerId: spec.id,
				taskId: task.id,
				state: aborted ? "cancelled" : "failed",
			});
		} finally {
			this.#running.delete(task.id);
			this.#busyWorkers.delete(spec.id);
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
	async #verifyOutcome(
		spec: WorkerSpec,
		task: OrchestratorTask,
		outcome: WorkerOutcome,
		signal: AbortSignal,
	): Promise<VerificationResult | undefined> {
		if (!this.#verifier) return undefined;
		if (this.#verificationChecks.length === 0) return undefined;
		if (outcome.exitCode !== 0 || signal.aborted) return undefined;
		this.#emit({
			type: "worker_state",
			workerId: spec.id,
			taskId: task.id,
			state: "verifying" satisfies WorkerLifecycleState,
		});

		const abortableVerifier = this.#verifier as AbortableVerifier;
		let result: VerificationResult;
		if (outcome.changes?.worktreePath) {
			result = await abortableVerifier.verify(outcome.changes.worktreePath, this.#verificationChecks, signal);
		} else if (outcome.changes?.branchName && this.#verifyBranch) {
			result = await this.#verifyBranch(
				this.#verificationRoot,
				outcome.changes.branchName,
				this.#verificationChecks,
				signal,
			);
		} else {
			result = await abortableVerifier.verify(this.#verificationRoot, this.#verificationChecks, signal);
		}
		logger.debug("orchestration verification finished", {
			taskId: task.id,
			ok: result.ok,
			firstFailure: result.firstFailure,
		});
		return result;
	}

	/**
	 * Integrate completed isolated tasks that have downstream pending dependents,
	 * so dependent tasks see their upstream dependencies' commits already landed.
	 */
	async #integrateForPendingDependents(): Promise<void> {
		if (!this.#integrator || this.#stopped) return;
		const ordered = this.#board.topologicalOrder();
		const candidates = ordered.filter(
			task =>
				this.#board.state(task.id) === "completed" &&
				!this.#integratedTasks.has(task.id) &&
				this.#hasPendingDependents(task.id) &&
				this.#changes.has(task.id),
		);
		if (candidates.length === 0) return;
		await this.#integrateTasks(candidates);
	}

	#hasPendingDependents(taskId: string): boolean {
		for (const candidate of this.#board.tasks()) {
			const state = this.#board.state(candidate.id);
			if (state !== "pending" && state !== "blocked") continue;
			if (candidate.dependencies.includes(taskId)) return true;
		}
		return false;
	}

	/**
	 * Land the branches workers produced.
	 *
	 * Orders pending branches in topological dependency order and only lands
	 * tasks that actually committed something: a worker with no changes has
	 * nothing to merge, and a failed or cancelled task's tree is incomplete. A
	 * failure here demotes the task that failed to merge and records the error in
	 * `#settledRecords`, while leaving sibling merges intact.
	 */
	async #integrate(_plan: OrchestratorPlan): Promise<void> {
		if (!this.#integrator || this.#stopped) return;
		await this.#integrateTasks(this.#board.topologicalOrder());
	}

	async #integrateTasks(tasks: readonly OrchestratorTask[]): Promise<void> {
		const integrator = this.#integrator;
		if (!integrator || this.#stopped) return;

		const pending: PendingIntegration[] = [];
		for (const task of tasks) {
			if (this.#integratedTasks.has(task.id)) continue;
			if (this.#board.state(task.id) !== "completed") continue;
			const isolated = this.#changes.get(task.id);
			if (!isolated) continue;

			if (!isolated.changes.branchName) {
				if (isolated.changes.patchPath) {
					this.#integratedTasks.add(task.id);
					const detail = isolated.changes.mergeSummary ?? `patch artifact at ${isolated.changes.patchPath}`;
					this.#changes.set(task.id, {
						workerId: isolated.workerId,
						changes: { ...isolated.changes, mergeSummary: detail },
					});
					this.#emit({
						type: "integration_finished",
						taskId: task.id,
						workerId: isolated.workerId,
						merged: true,
						detail,
					});
				}
				continue;
			}

			this.#integratedTasks.add(task.id);
			pending.push({
				taskId: task.id,
				workerId: isolated.workerId,
				branchName: isolated.changes.branchName,
				...(isolated.changes.baseSha === undefined ? {} : { baseSha: isolated.changes.baseSha }),
				targetFiles: task.targetFiles,
			});
		}
		if (pending.length === 0) return;

		for (const entry of pending) {
			this.#emit({
				type: "integration_started",
				taskId: entry.taskId,
				workerId: entry.workerId,
				branchName: entry.branchName,
			});
			this.#emit({ type: "worker_state", workerId: entry.workerId, taskId: entry.taskId, state: "merging" });
		}

		const controller = new AbortController();
		this.#integrationController = controller;
		if (this.#stopped) {
			controller.abort(this.#stoppedReason ?? "stopped");
		}
		let report: IntegrationReport;
		try {
			report = await integrator.integrate(pending, controller.signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("orchestration integration failed", { message, pending: pending.length });
			for (const entry of pending) {
				this.#board.transition(entry.taskId, "failed");
				this.#recordIntegrationError(entry.taskId, message);
				this.#emit({
					type: "integration_finished",
					taskId: entry.taskId,
					workerId: entry.workerId,
					merged: false,
					detail: message,
				});
				this.#emit({
					type: "worker_state",
					workerId: entry.workerId,
					taskId: entry.taskId,
					state: "failed",
				});
			}
			return;
		} finally {
			if (this.#integrationController === controller) {
				this.#integrationController = undefined;
			}
		}

		// `IntegrationReport` names branches, because that is what the integrator
		// works with; map back to the task that owns each branch.
		const merged = new Set(report.merged);
		for (const entry of pending) {
			const ok = merged.has(entry.branchName);
			// A branch that did not land leaves its task failed: the code the task
			// claimed to write is not on the target, so reporting it completed
			// would tell the caller work exists that does not.
			if (!ok) {
				const detail = report.summary ?? `failed to integrate branch "${entry.branchName}"`;
				this.#board.transition(entry.taskId, "failed");
				this.#recordIntegrationError(entry.taskId, detail);
			}
			this.#emit({
				type: "integration_finished",
				taskId: entry.taskId,
				workerId: entry.workerId,
				merged: ok,
				...(report.summary === undefined ? {} : { detail: report.summary }),
			});
			this.#emit({
				type: "worker_state",
				workerId: entry.workerId,
				taskId: entry.taskId,
				state: ok ? "completed" : "failed",
			});
		}
	}

	#recordIntegrationError(taskId: string, error: string): void {
		const existing = this.#settledRecords.get(taskId);
		this.#settledRecords.set(taskId, {
			taskId,
			outcome: existing?.outcome,
			verification: existing?.verification,
			cancelled: existing?.cancelled,
			error,
		});
	}

	/** Isolation artifacts recorded for one task, for callers rendering a report. */
	changesFor(taskId: string): WorkerChanges | undefined {
		return this.#changes.get(taskId)?.changes;
	}

	/** Move settled worker runs onto the board and charge the budget. */
	#drainSettled(): void {
		while (this.#settled.length > 0) {
			const settled = this.#settled.shift()!;
			// Retain before draining: this queue is emptied here, and the final
			// report reads the map beside it.
			this.#settledRecords.set(settled.taskId, settled);
			this.#budget.charge(settled.outcome?.usage ?? {}, settled.taskId);
			const state: TaskState = settled.cancelled
				? "cancelled"
				: settled.error
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
			outcomes.set(task.id, {
				state,
				workerId: this.#board.workerOf(task.id),
				attempts: this.#board.attempts(task.id),
			});
		}
		// Retained per task, not read from the (now empty) drain queue: the report
		// used to lose the worker's output, error, and verification verdict.
		for (const [taskId, settled] of this.#settledRecords) {
			const record = outcomes.get(taskId);
			if (!record) continue;
			outcomes.set(taskId, {
				...record,
				...(settled.outcome === undefined ? {} : { outcome: settled.outcome }),
				...(settled.error === undefined ? {} : { error: settled.error }),
				...(settled.verification === undefined ? {} : { verification: settled.verification }),
			});
		}
		return outcomes;
	}

	#workerFor(plan: OrchestratorPlan, task: OrchestratorTask): WorkerResolution {
		if (plan.workers.length === 0) return { kind: "none" };
		if (task.agent) {
			const matches = plan.workers.filter(
				worker =>
					worker.id === task.agent ||
					worker.roleLabel === task.agent ||
					(worker.agent !== undefined && worker.agent === task.agent),
			);
			if (matches.length > 0) {
				const freeMatch = matches.find(worker => !this.#busyWorkers.has(worker.id));
				return freeMatch ? { kind: "ready", spec: freeMatch } : { kind: "busy" };
			}
		}
		const free = plan.workers.find(worker => !this.#busyWorkers.has(worker.id));
		return free ? { kind: "ready", spec: free } : { kind: "busy" };
	}

	async #waitForSettlement(): Promise<void> {
		if (this.#notified || this.#settled.length > 0) {
			this.#notified = false;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#wake = resolve;
		const remainingMs = this.#budget.remainingWallClockMs();
		if (remainingMs === undefined) {
			await promise;
			this.#notified = false;
			return;
		}
		if (remainingMs <= 0) {
			this.#wake = undefined;
			this.#notified = false;
			return;
		}
		const timer = setTimeout(() => {
			this.#notify();
		}, remainingMs);
		timer.unref?.();
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			this.#notified = false;
		}
	}

	#notify(): void {
		const wake = this.#wake;
		if (wake) {
			this.#wake = undefined;
			wake();
		} else {
			this.#notified = true;
		}
	}

	#emitBudgetExhaustedOnce(reason: string): void {
		if (this.#budgetExhaustedEmitted) return;
		this.#budgetExhaustedEmitted = true;
		this.#emit({ type: "budget_exhausted", reason, usage: this.#budget.snapshot() });
	}

	#invokeRunnerCancel(workerId: string, taskId: string, reason: string): void {
		try {
			const maybePromise = this.#runner.cancel?.(workerId, taskId, reason);
			if (maybePromise && typeof maybePromise.then === "function") {
				void maybePromise.catch((error: unknown) => {
					logger.warn("orchestration runner cancel failed", {
						workerId,
						taskId,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		} catch (error) {
			logger.warn("orchestration runner cancel threw", {
				workerId,
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#emit(event: OrchestratorEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("orchestration event listener threw", {
					eventType: event.type,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

function formatVerificationFailureFeedback(verification: VerificationResult): string {
	const failed = verification.checks.find(check => !check.ok) ?? verification.checks.at(-1);
	const checkId = failed?.id ?? verification.firstFailure ?? "verification";
	const rawOutput = failed?.output?.trim();
	if (rawOutput && rawOutput.length > 0) {
		const tail = rawOutput.length > 2000 ? rawOutput.slice(-2000) : rawOutput;
		return `check "${checkId}" failed:\n${tail}`;
	}
	if (failed?.failure) {
		return `check "${checkId}" failed: ${failed.failure}`;
	}
	return `check "${checkId}" failed`;
}
