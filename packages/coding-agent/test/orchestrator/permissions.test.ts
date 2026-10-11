/**
 * Permission invariant contracts:
 * - effective child tools are the intersection of the parent's and requested
 *   tools, in parent order
 * - an unknown parent capability set never widens into "all"
 * - read-tier sets need no tier authorization; above-read-tier sets do
 */

import { describe, expect, test } from "bun:test";
import {
	assertWorkerSpawnAllowed,
	checkWorkerApprovalTier,
	intersectToolPermissions,
	isReadTierToolSet,
	resolveWorkerSpawnTools,
} from "../../src/orchestrator/permissions";
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

	test("an agent without tools yields no permitted set", () => {
		const tools = resolveWorkerSpawnTools({
			agent: { ...agent, tools: undefined },
			parentActiveTools: ["read", "write"],
		});
		expect(tools).toEqual([]);
	});
});

describe("checkWorkerApprovalTier", () => {
	test("allows read-tier sets under any parent mode", () => {
		expect(checkWorkerApprovalTier("always-ask", ["read", "grep"]).allowed).toBe(true);
	});

	test("allows above-read-tier sets only when the parent authorizes that tier", () => {
		expect(checkWorkerApprovalTier("yolo", ["read", "write"]).allowed).toBe(true);
		const denied = checkWorkerApprovalTier("always-ask", ["read", "write"]);
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain("approval mode");
	});

	test("treats unknown tools as above read tier", () => {
		expect(isReadTierToolSet(["totally_unknown"])).toBe(false);
		expect(checkWorkerApprovalTier("always-ask", ["totally_unknown"]).allowed).toBe(false);
	});
});

describe("assertWorkerSpawnAllowed", () => {
	test("returns the effective tools when the spawn is allowed", () => {
		expect(
			assertWorkerSpawnAllowed({ agent, parentActiveTools: ["read", "write"], parentApprovalMode: "yolo" }),
		).toEqual(["read", "write"]);
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
