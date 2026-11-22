/**
 * Worker permission rules.
 *
 * Requirement (neutral, by design): child permissions must be the intersection
 * of the parent's permissions and the requested permissions, and a child's
 * approval tier must not be looser than its parent's approval tier.
 *
 * The functions here are pure so the invariant is unit-testable without
 * spawning a session.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 2.3 and 8.
 */

import { ToolError } from "@marsai-org/tui/tools/tool-errors";
import { READ_ONLY_TOOL_NAMES } from "../task/read-only-policy";
import type { AgentDefinition } from "../task/types";
import type { ApprovalMode } from "../tools/approval";

/** What a worker asks for at spawn time. */
export interface WorkerPermissionRequest {
	/** Agent definition the worker would run as. */
	readonly agent: AgentDefinition;
	/** Tool names the parent session currently has active. */
	readonly parentActiveTools: readonly string[];
	/** Explicit per-worker tool request; defaults to the agent's own `tools`. */
	readonly requestedTools?: readonly string[];
	/** Parent session's approval mode; undefined when unknown. */
	readonly parentApprovalMode?: ApprovalMode;
}

/**
 * Effective child tools: the intersection of the parent's active tools and the
 * requested tools, in parent order.
 *
 * Fails closed: when the parent reports no active tools the result is empty,
 * because an unknown parent capability set must never be treated as "all".
 */
export function intersectToolPermissions(
	parentActiveTools: readonly string[],
	requestedTools: readonly string[],
): string[] {
	const parent = new Set(parentActiveTools);
	const effective: string[] = [];
	for (const tool of parentActiveTools) {
		if (requestedTools.includes(tool) && !effective.includes(tool)) effective.push(tool);
	}
	// Defensive: requested names unknown to the parent list can never widen it.
	return effective.filter(tool => parent.has(tool));
}

/** Tools the worker would run with, after the intersection with the parent. */
export function resolveWorkerSpawnTools(request: WorkerPermissionRequest): string[] {
	const requested = request.requestedTools ?? request.agent.tools ?? [];
	if (requested.length === 0) return [];
	return intersectToolPermissions(request.parentActiveTools, requested);
}

/**
 * Whether every tool in the set is read-tier per the shared read-only policy.
 * Unknown tools make the set not read-tier (fail-safe).
 */
export function isReadTierToolSet(tools: readonly string[]): boolean {
	return tools.length > 0 && tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

export interface ApprovalTierCheck {
	readonly allowed: boolean;
	readonly reason?: string;
}

/**
 * A worker runs unattended, so it may only execute the tool tiers the parent
 * session is authorized to run unattended. Read-tier tools are always allowed
 * because they observe nothing that the parent could not observe itself.
 */
export function checkWorkerApprovalTier(
	parentApprovalMode: ApprovalMode | undefined,
	tools: readonly string[],
): ApprovalTierCheck {
	if (isReadTierToolSet(tools)) return { allowed: true };
	if (parentApprovalMode === "yolo") return { allowed: true };
	return {
		allowed: false,
		reason:
			"worker requests tools above read tier, but the parent session's approval mode does not authorize unattended execution of that tier",
	};
}

/**
 * Throws when the spawn must not happen: no permitted tools, or a tier the
 * parent does not authorize. The message is a neutral requirement statement.
 */
export function assertWorkerSpawnAllowed(request: WorkerPermissionRequest): string[] {
	const effective = resolveWorkerSpawnTools(request);
	if (effective.length === 0) {
		throw new ToolError(
			"orchestrator: the worker's requested tools intersect to nothing with the parent session's active tools; child permissions must be the intersection of the parent's and the requested permissions",
		);
	}
	const tierCheck = checkWorkerApprovalTier(request.parentApprovalMode, effective);
	if (!tierCheck.allowed) {
		throw new ToolError(`orchestrator: ${tierCheck.reason}`);
	}
	return effective;
}
