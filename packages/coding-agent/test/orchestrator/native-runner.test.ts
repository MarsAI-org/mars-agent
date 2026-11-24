/**
 * NativeWorkerRunner runtime contracts:
 * - permission failures inside `run()` return `{ exitCode: 1 }` instead of throwing
 * - sequential tasks and retries on the same worker allocate distinct subagent IDs
 * - isolated workers pass `isolation.apply: false` and `keepAlive: false`
 * - live `onProgress` events forward output lines and token/request usage to `context.reportProgress`
 * - retry feedback and active file leases are injected into the subagent assignment
 * - per-worker `agent` and `model` overrides resolve against discovered agents and spawn policy
 * - partial token/request usage on `StructuredSubagentError.result` survives execution failures
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentProgress, SingleResult } from "@marsai-org/tui/tools/task";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import type { WorkerProgressUpdate, WorkerRunContext } from "../../src/orchestrator/engine";
import { NativeWorkerRunner } from "../../src/orchestrator/native-runner";
import type { OrchestratorTask, WorkerSpec } from "../../src/orchestrator/types";
import * as structuredSubagentModule from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const BASE_AGENT: AgentDefinition = {
	name: "task",
	description: "Default task worker",
	systemPrompt: "You are a worker.",
	tools: ["read", "grep", "edit", "write"],
	source: "bundled",
};

const SCOUT_AGENT: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	tools: ["read", "grep"],
	source: "bundled",
};

function makeSession(spawns = "*"): ToolSession {
	const settings = Settings.isolated({});
	return {
		cwd: "/tmp/mars-native-runner-test",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

function makeContext(overrides: Partial<WorkerRunContext> = {}): WorkerRunContext {
	return {
		signal: new AbortController().signal,
		leases: [],
		attempt: 1,
		sendMessage: async message => ({
			...message,
			id: "msg-1",
			from: "worker-1",
			ts: 1,
			status: "delivered",
		}),
		...overrides,
	};
}

function makeTask(id: string, description = `Execute ${id}`): OrchestratorTask {
	return {
		id,
		title: `Task ${id}`,
		description,
		dependencies: [],
		targetFiles: [`src/${id}.ts`],
	};
}

function makeSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
	return {
		id: "worker-1",
		roleLabel: "backend",
		backend: "native",
		isolated: false,
		...overrides,
	};
}

function makeSubagentResult(overrides: Partial<SingleResult> = {}): structuredSubagentModule.StructuredSubagentResult {
	const single: SingleResult = {
		index: 0,
		id: "worker-1-t1",
		agent: "task",
		agentSource: "bundled",
		task: "Execute t1",
		assignment: "Execute t1",
		exitCode: 0,
		output: "completed task output",
		stderr: "",
		truncated: false,
		durationMs: 25,
		tokens: 420,
		requests: 3,
		...overrides,
	};
	return {
		result: single,
		policy: {} as structuredSubagentModule.EffectiveSubagentPolicy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp/mars-artifacts",
		temporaryArtifacts: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("NativeWorkerRunner", () => {
	test("clamps permissions inside try/catch and returns exitCode 1 instead of throwing on disallowed tier", async () => {
		const spy = vi.spyOn(structuredSubagentModule, "runStructuredSubagent");
		const session = makeSession();
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			parentActiveTools: ["read", "edit", "write"],
			parentApprovalMode: "always-ask",
			session,
		});

		const outcome = await runner.run(makeSpec(), makeTask("t1"), makeContext());

		expect(spy).not.toHaveBeenCalled();
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toBe("");
		expect(outcome.error).toContain("above read tier");
	});

	test("allocates unique per-task and per-retry subagent IDs and passes isolation.apply: false and keepAlive: false", async () => {
		const seenRequests: structuredSubagentModule.StructuredSubagentRequest[] = [];
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			seenRequests.push(request);
			return makeSubagentResult({
				id: request.identity?.id ?? "sub",
				branchName: `mars/task/${request.identity?.id ?? "sub"}`,
				branchBaseSha: "deadbeef",
			});
		});

		const session = makeSession();
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			parentActiveTools: ["read", "grep", "edit", "write"],
			parentApprovalMode: "write",
			session,
		});

		const spec = makeSpec({ id: "worker-1", roleLabel: "svc", isolated: true });
		const first = await runner.run(spec, makeTask("task-a"), makeContext({ attempt: 1 }));
		const retry = await runner.run(spec, makeTask("task-a"), makeContext({ attempt: 2 }));
		const second = await runner.run(spec, makeTask("task-b"), makeContext({ attempt: 1 }));

		expect(seenRequests).toHaveLength(3);
		expect(seenRequests[0]?.identity).toEqual({ id: "worker-1-task-a", label: "svc" });
		expect(seenRequests[1]?.identity).toEqual({ id: "worker-1-task-a-r2", label: "svc" });
		expect(seenRequests[2]?.identity).toEqual({ id: "worker-1-task-b", label: "svc" });

		expect(seenRequests[0]?.keepAlive).toBe(false);
		expect(seenRequests[0]?.blockedAgent).toBeUndefined();
		expect(seenRequests[0]?.isolation).toEqual({
			requested: true,
			merge: "branch",
			apply: false,
			allowWithoutSetting: true,
		});
		expect(first.changes).toMatchObject({
			branchName: "mars/task/worker-1-task-a",
			baseSha: "deadbeef",
			hasChanges: true,
		});
		expect(retry.changes?.branchName).toBe("mars/task/worker-1-task-a-r2");
		expect(second.changes?.branchName).toBe("mars/task/worker-1-task-b");
	});

	test("injects active file leases and verification retry feedback into the subagent assignment", async () => {
		let capturedAssignment = "";
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			capturedAssignment = request.assignment;
			return makeSubagentResult();
		});

		const session = makeSession();
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			parentActiveTools: ["read", "edit"],
			parentApprovalMode: "write",
			session,
		});

		await runner.run(
			makeSpec(),
			makeTask("t1", "Implement parser"),
			makeContext({
				attempt: 2,
				leases: [{ path: "src/parser.ts", mode: "write", workerId: "worker-1", acquiredAt: 100 }],
				retryFeedback: 'check "check-1" failed:\nType error on line 42',
			}),
		);

		expect(capturedAssignment).toContain("Implement parser");
		expect(capturedAssignment).toContain("src/parser.ts (write)");
		expect(capturedAssignment).toContain("Previous attempt failed verification:");
		expect(capturedAssignment).toContain('check "check-1" failed:\nType error on line 42');
	});

	test("forwards live onProgress output lines, token usage, and final branchName to context.reportProgress", async () => {
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			request.onProgress?.({
				recentOutput: ["reading src/a.ts"],
				tokens: 150,
				requests: 1,
			} as unknown as AgentProgress);
			request.onProgress?.({
				currentTool: "edit",
				currentToolArgs: "src/a.ts",
				tokens: 320,
				turnCount: 2,
			} as unknown as AgentProgress);
			return makeSubagentResult({
				tokens: 500,
				requests: 3,
				branchName: "mars/task/worker-1-t1",
				usage: {
					input: 300,
					output: 200,
					cacheRead: 50,
					cacheWrite: 10,
					totalTokens: 560,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		});

		const session = makeSession();
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			parentActiveTools: ["read", "edit"],
			parentApprovalMode: "write",
			session,
		});

		const updates: WorkerProgressUpdate[] = [];
		const outcome = await runner.run(
			makeSpec({ isolated: true }),
			makeTask("t1"),
			makeContext({
				reportProgress: update => updates.push(update),
			}),
		);

		expect(updates).toEqual([
			{ outputLine: "reading src/a.ts", usage: { totalTokens: 150, requests: 1 } },
			{ outputLine: "edit: src/a.ts", usage: { totalTokens: 320, requests: 2 } },
			{ branchName: "mars/task/worker-1-t1" },
		]);
		expect(outcome.usage).toEqual({
			inputTokens: 300,
			outputTokens: 200,
			cacheReadTokens: 50,
			cacheWriteTokens: 10,
			totalTokens: 500,
			requests: 3,
		});
	});

	test("resolves per-worker agent definition and model override when allowed by spawn policy", async () => {
		let capturedRequest: structuredSubagentModule.StructuredSubagentRequest | undefined;
		let registeredSessionAgents: readonly AgentDefinition[] = [];
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			capturedRequest = request;
			registeredSessionAgents = request.session.getSessionAgents?.() ?? [];
			return makeSubagentResult({ agent: request.agent ?? "task" });
		});

		const session = makeSession("scout,task");
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			agents: [BASE_AGENT, SCOUT_AGENT],
			parentActiveTools: ["read", "grep", "edit"],
			parentApprovalMode: "always-ask",
			session,
		});

		const outcome = await runner.run(
			makeSpec({
				agent: "scout",
				model: "anthropic/claude-sonnet-4-5",
			}),
			makeTask("t1"),
			makeContext(),
		);

		expect(outcome.exitCode).toBe(0);
		expect(capturedRequest?.agent).toBe("scout");
		expect(capturedRequest?.model).toBe("anthropic/claude-sonnet-4-5");
		const scoutSessionDef = registeredSessionAgents.find(a => a.name === "scout");
		expect(scoutSessionDef?.tools).toEqual(["read", "grep"]);
		expect(scoutSessionDef?.model).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	test("preserves partial token and request usage when StructuredSubagentError carries a settled result", async () => {
		const partialSingleResult = makeSubagentResult({
			exitCode: 1,
			output: "partial progress before failure",
			tokens: 780,
			requests: 4,
			error: "isolation capture failed",
		}).result;

		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockRejectedValue(
			new structuredSubagentModule.StructuredSubagentError("execution", "Subagent execution failed", {
				result: partialSingleResult,
			}),
		);

		const session = makeSession();
		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			parentActiveTools: ["read", "grep"],
			parentApprovalMode: "always-ask",
			session,
		});

		const outcome = await runner.run(makeSpec(), makeTask("t1"), makeContext());

		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toBe("partial progress before failure");
		expect(outcome.error).toContain("Subagent execution failed");
		expect(outcome.usage).toEqual({
			totalTokens: 780,
			requests: 4,
		});
	});

	test("passes real resolveEffectiveSubagentPolicy preflight without self-blocking or requiring task.isolation.enabled", async () => {
		const session = makeSession("*");
		const capturedPolicies: structuredSubagentModule.EffectiveSubagentPolicy[] = [];
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			// Exercise the real unmocked preflight policy guard (recursion prevention + isolation gate).
			const policy = await structuredSubagentModule.resolveEffectiveSubagentPolicy(request);
			capturedPolicies.push(policy);
			return makeSubagentResult({ id: request.identity?.id ?? "w1-t1" });
		});

		const runner = new NativeWorkerRunner({
			settings: session.settings,
			cwd: session.cwd,
			agent: BASE_AGENT,
			agents: [BASE_AGENT, SCOUT_AGENT],
			parentActiveTools: ["read", "grep", "edit", "write"],
			parentApprovalMode: "yolo",
			taskDepth: 1,
			session,
		});

		const outcome = await runner.run(makeSpec({ isolated: true }), makeTask("t1"), makeContext());

		expect(outcome.exitCode).toBe(0);
		expect(outcome.error).toBeUndefined();
		expect(capturedPolicies).toHaveLength(1);
		expect(capturedPolicies[0]?.agentName).toBe("task");
		expect(capturedPolicies[0]?.isIsolated).toBe(true);
		expect(capturedPolicies[0]?.effectiveAgent.tools).not.toContain("orchestrate");
	});
});
