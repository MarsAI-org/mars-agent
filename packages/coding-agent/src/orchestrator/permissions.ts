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

/** Built-in tools whose capability tier is `write` (authorized under `write` and `yolo` approval modes). */
export const WRITE_TIER_TOOL_NAMES: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"ast_edit",
	"notebook",
	"todo_write",
	"context_notes",
	"new_context",
	"manage_skill",
	"generate_image",
	"learn",
	"retain",
]);

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
	/** Optional user per-tool approval overrides (`tools.approval.<tool>: allow | deny | prompt`). */
	readonly userToolPolicies?: Readonly<Record<string, unknown>>;
}

function isDeniedByUserPolicy(tool: string, policies?: Readonly<Record<string, unknown>>): boolean {
	if (!policies) return false;
	const value = policies[tool];
	if (typeof value === "string") {
		return value.trim().toLowerCase() === "deny";
	}
	if (value !== null && typeof value === "object" && "policy" in value) {
		const policy = (value as { policy?: unknown }).policy;
		return typeof policy === "string" && policy.trim().toLowerCase() === "deny";
	}
	return false;
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

/**
 * Tools the worker would run with, after intersecting with the parent and
 * filtering out any tools explicitly denied by user approval policy.
 *
 * When both `request.requestedTools` and `request.agent.tools` are `undefined`
 * (an agent definition meaning "all tools", such as the bundled `task` agent),
 * the worker inherits `request.parentActiveTools` excluding `"orchestrate"` by
 * default (to prevent recursive orchestration unless explicitly requested in
 * `request.requestedTools`). An empty `parentActiveTools` or an explicit `[]`
 * in `requestedTools` or `agent.tools` still fails closed (`[]`).
 */
export function resolveWorkerSpawnTools(request: WorkerPermissionRequest): string[] {
	if (request.parentActiveTools.length === 0) return [];

	let requested: readonly string[];
	if (request.requestedTools !== undefined) {
		requested = request.requestedTools;
	} else if (request.agent.tools !== undefined) {
		requested = request.agent.tools.filter(tool => tool !== "orchestrate");
	} else {
		requested = request.parentActiveTools.filter(tool => tool !== "orchestrate");
	}

	if (requested.length === 0) return [];
	const intersected = intersectToolPermissions(request.parentActiveTools, requested);
	if (!request.userToolPolicies) return intersected;
	return intersected.filter(tool => !isDeniedByUserPolicy(tool, request.userToolPolicies));
}

/**
 * Whether every tool in the set is read-tier per the shared read-only policy.
 * Unknown tools make the set not read-tier (fail-safe).
 */
export function isReadTierToolSet(tools: readonly string[]): boolean {
	return tools.length > 0 && tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Whether every tool in the set is at most write-tier (read-tier or write-tier).
 * Exec-tier (`bash`, `eval`, etc.) and unknown tools return false.
 */
export function isWriteTierToolSet(tools: readonly string[]): boolean {
	return tools.length > 0 && tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool) || WRITE_TIER_TOOL_NAMES.has(tool));
}

export interface ApprovalTierCheck {
	readonly allowed: boolean;
	readonly reason?: string;
}

/**
 * A worker runs unattended, so it may only execute the tool tiers the parent
 * session is authorized to run unattended.
 *
 * - Read-tier tools are always allowed.
 * - `"yolo"` authorizes all tiers (`read`, `write`, `exec`).
 * - `"write"` authorizes `read` and `write` tiers, rejecting `exec`/unknown tools.
 * - `"always-ask"` or `undefined` authorizes `read` tier only.
 */
export function checkWorkerApprovalTier(
	parentApprovalMode: ApprovalMode | undefined,
	tools: readonly string[],
	userToolPolicies?: Readonly<Record<string, unknown>>,
): ApprovalTierCheck {
	if (userToolPolicies) {
		const deniedTool = tools.find(tool => isDeniedByUserPolicy(tool, userToolPolicies));
		if (deniedTool !== undefined) {
			return {
				allowed: false,
				reason: `worker requests tool "${deniedTool}" which is denied by user approval policy`,
			};
		}
	}
	if (isReadTierToolSet(tools)) return { allowed: true };
	if (parentApprovalMode === "yolo") return { allowed: true };
	if (parentApprovalMode === "write") {
		if (isWriteTierToolSet(tools)) return { allowed: true };
		return {
			allowed: false,
			reason:
				"worker requests tools above write tier, but the parent session's approval mode does not authorize unattended execution of that tier",
		};
	}
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
	const tierCheck = checkWorkerApprovalTier(request.parentApprovalMode, effective, request.userToolPolicies);
	if (!tierCheck.allowed) {
		throw new ToolError(`orchestrator: ${tierCheck.reason}`);
	}
	return effective;
}
