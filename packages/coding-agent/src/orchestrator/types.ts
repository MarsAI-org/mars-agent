/**
 * Core types for the multi-agent orchestrator.
 *
 * The orchestrator coordinates worker sessions that share one goal. It is a
 * coordination layer over the existing subagent/task machinery: worker
 * identities come from the agent registry, typed peer messages cross the
 * in-process message bus, and native workers spawn through the task executor.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md (sections 4, 5, 6, 8).
 */

/** Lifecycle states for a worker session. */
export type WorkerLifecycleState =
	| "pending"
	| "spawning"
	| "running"
	| "idle"
	| "verifying"
	| "merging"
	| "completed"
	| "failed"
	| "cancelled";

/** Worker execution backends. `external-cli` arrives with the adapter milestone. */
export type WorkerBackendKind = "native" | "external-cli";

/** Lifecycle states for one planned task. */
export type TaskState = "pending" | "blocked" | "running" | "completed" | "failed" | "cancelled";

/** Typed kinds for inter-worker messages. */
export type OrchestratorMessageKind = "status" | "coordination" | "handoff" | "query" | "reply" | "alert";

/** One typed message between workers (or between a worker and the parent). */
export interface OrchestratorMessage {
	readonly id: string;
	/** Sender worker id (or the parent id for parent-originated messages). */
	readonly from: string;
	/** Recipient worker id, or "all" for a broadcast. */
	readonly to: string;
	readonly kind: OrchestratorMessageKind;
	readonly body: string;
	readonly ts: number;
	/** Delivery status, updated by the message bus once delivery resolves. */
	readonly status: "sent" | "delivered" | "failed";
}

/** One planned unit of work assigned to exactly one worker. */
export interface OrchestratorTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	/** Task ids that must complete before this task may start. */
	readonly dependencies: readonly string[];
	/** Declared write set; the lease manager enforces exclusivity on these paths. */
	readonly targetFiles: readonly string[];
	/** Optional agent definition name this task prefers (defaults to the session agent). */
	readonly agent?: string;
}

/** A worker the orchestrator may run: identity plus the tools it requests. */
export interface WorkerSpec {
	readonly id: string;
	/** Short role label shown in the UI (for example "svc", "helm", "frontend"). */
	readonly roleLabel: string;
	readonly backend: WorkerBackendKind;
	/** Tools the worker requests; intersected with the parent's active tools. */
	readonly requestedTools?: readonly string[];
	/** Optional model pattern override for this worker. */
	readonly model?: string;
	/** Whether this worker runs inside an isolated checkout. */
	readonly isolated: boolean;
}

/** The whole orchestration run: one goal, its tasks, and its workers. */
export interface OrchestratorPlan {
	readonly id: string;
	readonly goal: string;
	readonly tasks: readonly OrchestratorTask[];
	readonly workers: readonly WorkerSpec[];
}

/** Request for one path lease held by a worker. */
export interface FileLeaseRequest {
	readonly path: string;
	readonly mode: "read" | "write";
}

/** Result of an all-or-nothing lease acquisition. */
export interface FileLeaseResult {
	readonly granted: boolean;
	readonly workerId: string;
	readonly leases: readonly FileLease[];
	/** Present when `granted` is false: paths held by other workers. */
	readonly conflicts: readonly FileLease[];
}

/** One granted lease. */
export interface FileLease {
	readonly path: string;
	readonly mode: "read" | "write";
	readonly workerId: string;
	readonly acquiredAt: number;
}

/** Per-worker accounting returned by a worker run. */
export interface WorkerUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly reasoningTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens?: number;
	readonly requests?: number;
}

/**
 * What a worker's isolated checkout produced. Present only for workers that ran
 * with `isolated: true`; the engine uses it to drive the integration phase.
 */
export interface WorkerChanges {
	/** Temporary branch carrying the worker's commits, when it committed any. */
	readonly branchName?: string;
	/** Patch artifact written when the branch could not be created. */
	readonly patchPath?: string;
	/** Base revision the branch was cut from, for the cherry-pick range. */
	readonly baseSha?: string;
	/** True when the worker's tree differed from its baseline at all. */
	readonly hasChanges: boolean;
	/** Human summary of what the merge step did, when it ran. */
	readonly mergeSummary?: string;
}

/** What a worker run reports back to the orchestrator. */
export interface WorkerOutcome {
	readonly exitCode: number;
	readonly output: string;
	readonly error?: string;
	readonly usage?: WorkerUsage;
	/** Isolation artifacts; absent for workers that ran in the shared checkout. */
	readonly changes?: WorkerChanges;
}

/** Union of events the engine emits for the UI and for tests. */
export type OrchestratorEvent =
	| {
			readonly type: "plan_started";
			readonly planId: string;
			readonly taskCount: number;
			readonly workerCount: number;
	  }
	| {
			readonly type: "task_state";
			readonly taskId: string;
			readonly from: TaskState;
			readonly to: TaskState;
			readonly workerId?: string;
	  }
	| {
			readonly type: "worker_state";
			readonly workerId: string;
			readonly taskId: string;
			readonly state: WorkerLifecycleState;
	  }
	| { readonly type: "message"; readonly message: OrchestratorMessage }
	| {
			readonly type: "leases_granted";
			readonly taskId: string;
			readonly workerId: string;
			readonly paths: readonly string[];
	  }
	| { readonly type: "budget_exhausted"; readonly reason: string; readonly usage: UsageTotals }
	| {
			/** One worker's isolated changes are being integrated into the parent checkout. */
			readonly type: "integration_started";
			readonly taskId: string;
			readonly workerId: string;
			readonly branchName?: string;
	  }
	| {
			/** The integration phase settled for one worker. */
			readonly type: "integration_finished";
			readonly taskId: string;
			readonly workerId: string;
			readonly merged: boolean;
			readonly detail?: string;
	  }
	| {
			readonly type: "plan_finished";
			readonly planId: string;
			readonly stoppedReason?: string;
			readonly usage: UsageTotals;
	  };

/** Aggregate accounting for a run. */
export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	requests: number;
	wallClockMs: number;
	/** Cost in provider-agnostic units is not tracked here; see session stats. */
}
