/**
 * Permission invariant contracts:
 * - effective child tools are the intersection of the parent's and requested
 *   tools, in parent order
 * - an agent with `tools: undefined` (like bundled `task`) inherits parent
 *   active tools excluding `orchestrate` by default
 * - an unknown parent capability set or explicit `[]` fails closed
 * - user `deny` policies strip denied tools before tier checking
 * - read-tier sets are allowed in any mode; write-tier sets are allowed under
 *   `write` and `yolo`; exec-tier sets require `yolo`
 */

import { describe, expect, test } from "bun:test";
import {
	assertWorkerSpawnAllowed,
	checkWorkerApprovalTier,
	intersectToolPermissions,
	isReadTierToolSet,
	isWriteTierToolSet,
	resolveWorkerSpawnTools,
} from "../../src/orchestrator/permissions";
import { planWorkerSpawn, requireWorkerSpawn } from "../../src/orchestrator/worker-session";
import type { AgentDefinition } from "../../src/task/types";

const agent: AgentDefinition = {
	name: "worker",
	description: "test worker",
	systemPrompt: "test",
	tools: ["read", "write", "bash"],
	source: "bundled",
};

describe("intersectToolPermissions", () => {
	test("intersects parent and requested tools in parent order", () => {
		expect(intersectToolPermissions(["read", "grep", "write"], ["write", "read"])).toEqual(["read", "write"]);
	});

	test("returns nothing when the parent lacks the requested tools", () => {
		expect(intersectToolPermissions(["read", "grep"], ["write", "bash"])).toEqual([]);
	});

	test("an unknown parent capability set fails closed", () => {
		expect(intersectToolPermissions([], ["read", "write"])).toEqual([]);
	});

	test("never duplicates a repeated request", () => {
		expect(intersectToolPermissions(["read", "write"], ["write", "write"])).toEqual(["write"]);
	});
});

describe("resolveWorkerSpawnTools", () => {
	test("defaults the request to the agent definition's tools", () => {
		const tools = resolveWorkerSpawnTools({ agent, parentActiveTools: ["read", "write"] });
		expect(tools).toEqual(["read", "write"]);
	});

	test("an explicit request narrows the agent definition", () => {
		const tools = resolveWorkerSpawnTools({
			agent,
			parentActiveTools: ["read", "write", "bash"],
			requestedTools: ["read"],
		});
		expect(tools).toEqual(["read"]);
	});

	test("an agent with tools: undefined inherits parent active tools excluding orchestrate", () => {
		const tools = resolveWorkerSpawnTools({
			agent: { ...agent, tools: undefined },
			parentActiveTools: ["read", "write", "bash", "orchestrate"],
		});
		expect(tools).toEqual(["read", "write", "bash"]);
	});

	test("explicit requestedTools can include orchestrate when parent has it", () => {
		const tools = resolveWorkerSpawnTools({
			agent: { ...agent, tools: undefined },
			parentActiveTools: ["read", "orchestrate"],
			requestedTools: ["read", "orchestrate"],
		});
		expect(tools).toEqual(["read", "orchestrate"]);
	});

	test("fails closed when parentActiveTools is empty or requestedTools is explicitly empty", () => {
		expect(
			resolveWorkerSpawnTools({
				agent: { ...agent, tools: undefined },
				parentActiveTools: [],
			}),
		).toEqual([]);
		expect(
			resolveWorkerSpawnTools({
				agent: { ...agent, tools: undefined },
				parentActiveTools: ["read", "write"],
				requestedTools: [],
			}),
		).toEqual([]);
	});

	test("filters out tools whose user approval policy is deny", () => {
		const tools = resolveWorkerSpawnTools({
			agent: { ...agent, tools: undefined },
			parentActiveTools: ["read", "write", "bash"],
			userToolPolicies: { bash: "deny", write: { policy: "DENY" }, read: "allow" },
		});
		expect(tools).toEqual(["read"]);
	});
});

describe("checkWorkerApprovalTier", () => {
	test("allows read-tier sets under any parent mode including undefined", () => {
		expect(checkWorkerApprovalTier("always-ask", ["read", "grep"]).allowed).toBe(true);
		expect(checkWorkerApprovalTier(undefined, ["read", "grep"]).allowed).toBe(true);
	});

	test("write mode allows read + write-tier tools and rejects exec-tier tools", () => {
		expect(isWriteTierToolSet(["read", "write", "edit", "ast_edit", "notebook", "todo_write"])).toBe(true);
		expect(
			checkWorkerApprovalTier("write", ["read", "write", "edit", "ast_edit", "notebook", "todo_write"]).allowed,
		).toBe(true);

		const execDenied = checkWorkerApprovalTier("write", ["read", "write", "bash"]);
		expect(execDenied.allowed).toBe(false);
		expect(execDenied.reason).toContain("approval mode");
	});

	test("allows exec-tier sets only under yolo mode", () => {
		expect(checkWorkerApprovalTier("yolo", ["read", "write", "bash"]).allowed).toBe(true);
		const denied = checkWorkerApprovalTier("always-ask", ["read", "write"]);
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain("approval mode");
	});

	test("treats unknown tools as above read and write tiers", () => {
		expect(isReadTierToolSet(["totally_unknown"])).toBe(false);
		expect(isWriteTierToolSet(["totally_unknown"])).toBe(false);
		expect(checkWorkerApprovalTier("always-ask", ["totally_unknown"]).allowed).toBe(false);
		expect(checkWorkerApprovalTier("write", ["totally_unknown"]).allowed).toBe(false);
	});

	test("rejects tools explicitly denied by userToolPolicies", () => {
		const check = checkWorkerApprovalTier("yolo", ["read", "bash"], { bash: "deny" });
		expect(check.allowed).toBe(false);
		expect(check.reason).toContain("denied");
	});
});

describe("assertWorkerSpawnAllowed & worker-session", () => {
	test("returns the effective tools when the spawn is allowed", () => {
		expect(
			assertWorkerSpawnAllowed({ agent, parentActiveTools: ["read", "write"], parentApprovalMode: "write" }),
		).toEqual(["read", "write"]);
	});

	test("strips user-denied exec tools so a write-mode worker can still spawn with write tools", () => {
		const plan = requireWorkerSpawn({
			agent: { ...agent, tools: undefined },
			parentActiveTools: ["read", "edit", "bash"],
			parentApprovalMode: "write",
			userToolPolicies: { bash: "deny" },
		});
		expect(plan.tools).toEqual(["read", "edit"]);
		expect(plan.approvalTier.allowed).toBe(true);
	});

	test("planWorkerSpawn threads userToolPolicies without throwing on denied tier", () => {
		const plan = planWorkerSpawn({
			agent,
			parentActiveTools: ["read", "write", "bash"],
			parentApprovalMode: "write",
			userToolPolicies: { write: "deny" },
		});
		expect(plan.tools).toEqual(["read", "bash"]);
		expect(plan.approvalTier.allowed).toBe(false);
	});

	test("throws when the intersection is empty", () => {
		expect(() =>
			assertWorkerSpawnAllowed({ agent, parentActiveTools: ["grep"], parentApprovalMode: "yolo" }),
		).toThrow(/intersect to nothing/);
	});

	test("throws when the parent does not authorize the requested tier", () => {
		expect(() =>
			assertWorkerSpawnAllowed({ agent, parentActiveTools: ["read", "write"], parentApprovalMode: "always-ask" }),
		).toThrow(/approval mode/);
	});
});
