/**
 * Worker spawn planning.
 *
 * Turns a permission request into the concrete tool set a worker may run with,
 * applying the permission invariant before anything is spawned.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md section 8 (permission invariant).
 */

import type { ApprovalTierCheck, WorkerPermissionRequest } from "./permissions";
import { assertWorkerSpawnAllowed, checkWorkerApprovalTier, resolveWorkerSpawnTools } from "./permissions";

export interface WorkerSpawnPlan {
	/** Effective tools: the intersection of the parent's and the requested tools. */
	readonly tools: readonly string[];
	/** Whether the parent's approval tier authorizes unattended execution of those tools. */
	readonly approvalTier: ApprovalTierCheck;
}

/** Plan a worker spawn without spawning it. */
export function planWorkerSpawn(request: WorkerPermissionRequest): WorkerSpawnPlan {
	const tools = resolveWorkerSpawnTools(request);
	return { tools, approvalTier: checkWorkerApprovalTier(request.parentApprovalMode, tools) };
}

/**
 * Plan a worker spawn and enforce the invariant: throws when the effective
 * tool set is empty or the approval tier is not authorized.
 */
export function requireWorkerSpawn(request: WorkerPermissionRequest): WorkerSpawnPlan {
	const tools = assertWorkerSpawnAllowed(request);
	return { tools, approvalTier: checkWorkerApprovalTier(request.parentApprovalMode, tools) };
}
