import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SingleResult } from "@marsai-org/tui/tools/task";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import { createNativeOrchestrationEngine } from "@marsai-org/coding-agent/orchestrator/native-runner";
import {
	cfgOrchestratorAllowProjectVerificationChecks,
	cfgOrchestratorMaxRetries,
	cfgOrchestratorVerificationChecks,
	resolveOrchestratorVerificationChecks,
} from "@marsai-org/coding-agent/orchestrator/settings";
import { ShellVerifier } from "@marsai-org/coding-agent/orchestrator/verifier";
import * as structuredSubagentModule from "@marsai-org/coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@marsai-org/coding-agent/task/types";
import type { ToolSession } from "@marsai-org/coding-agent/tools";

const WORKER_AGENT: AgentDefinition = {
	name: "task",
	description: "Worker agent",
	systemPrompt: "Worker",
	tools: ["read"],
	source: "bundled",
};

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp/orchestrator-verification",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

function makeExecutionResult(): structuredSubagentModule.StructuredSubagentResult {
	const single: SingleResult = {
		index: 0,
		id: "w1-t1",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		assignment: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 50,
		requests: 1,
	};
	return {
		result: single,
		policy: {} as structuredSubagentModule.EffectiveSubagentPolicy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp/orchestrator-verification-artifacts",
		temporaryArtifacts: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("orchestrator verification checks", () => {
	it("is empty by default, so verification stays off unless asked for", () => {
		const settings = Settings.isolated({});
		expect(cfgOrchestratorVerificationChecks.get(settings)).toEqual([]);
		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([]);
	});

	it("maps configured commands onto stable check ids in order", () => {
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["bun run check", "bun test"]);

		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([
			{ id: "check-1", command: "bun run check" },
			{ id: "check-2", command: "bun test" },
		]);
	});

	it("drops blank entries and numbers surviving checks sequentially", () => {
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["  ", "bun run check", "", "bun test  "]);

		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([
			{ id: "check-1", command: "bun run check" },
			{ id: "check-2", command: "bun test" },
		]);
	});

	it("rejects a task in createNativeOrchestrationEngine when a configured verification check fails", async () => {
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["bun run check"]);
		cfgOrchestratorMaxRetries.set(settings, 0);

		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockResolvedValue(makeExecutionResult());
		vi.spyOn(ShellVerifier.prototype, "verify").mockResolvedValue({
			ok: false,
			firstFailure: "check-1",
			checks: [
				{
					id: "check-1",
					command: "bun run check",
					ok: false,
					exitCode: 1,
					output: "typecheck error in src/index.ts",
					durationMs: 12,
				},
			],
		});

		const engine = createNativeOrchestrationEngine({
			settings,
			cwd: "/tmp/orchestrator-verification",
			agent: WORKER_AGENT,
			parentActiveTools: ["read"],
			parentApprovalMode: "always-ask",
			session: makeSession(settings),
			isolateWorkers: false,
		});

		const report = await engine.run({
			id: "plan-verify-fail",
			goal: "verify gate",
			tasks: [
				{
					id: "t1",
					title: "Task 1",
					description: "do t1",
					dependencies: [],
					targetFiles: [],
				},
			],
			workers: [{ id: "w1", roleLabel: "w1", backend: "native", isolated: false }],
		});

		const outcome = report.outcomes.get("t1");
		expect(outcome?.state).toBe("failed");
		expect(outcome?.verification?.ok).toBe(false);
		expect(outcome?.verification?.firstFailure).toBe("check-1");
	});

	it("ignores project-sourced verification checks when allowProjectVerificationChecks is false", async () => {
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["bun run untrusted-check"]);
		cfgOrchestratorAllowProjectVerificationChecks.set(settings, false);
		vi.spyOn(settings, "getProvenance").mockReturnValue("project");
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockResolvedValue(makeExecutionResult());
		const verifySpy = vi.spyOn(ShellVerifier.prototype, "verify");

		const engine = createNativeOrchestrationEngine({
			settings,
			cwd: "/tmp/orchestrator-verification",
			agent: WORKER_AGENT,
			parentActiveTools: ["read"],
			parentApprovalMode: "always-ask",
			session: makeSession(settings),
			isolateWorkers: false,
		});

		const report = await engine.run({
			id: "plan-project-untrusted",
			goal: "untrusted project check",
			tasks: [
				{
					id: "t1",
					title: "Task 1",
					description: "do t1",
					dependencies: [],
					targetFiles: [],
				},
			],
			workers: [{ id: "w1", roleLabel: "w1", backend: "native", isolated: false }],
		});

		expect(verifySpy).not.toHaveBeenCalled();
		expect(report.outcomes.get("t1")?.state).toBe("completed");
	});
});
