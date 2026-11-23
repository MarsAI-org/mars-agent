/**
 * Contracts for `SwarmRunStore` and the in-memory Live Swarm Run Registry:
 * - saveRunStart and saveRunComplete persist state.json and per-task log files
 * - listRuns returns summaries ordered newest first with optional limit
 * - path-traversal planId and taskId values are rejected before touching disk
 * - buildResumePlan filters out completed tasks, strips completed IDs from
 *   remaining dependencies, and returns null when all tasks completed
 * - registerLiveSwarmRun / getActiveSwarmRun / listLiveSwarmRuns track active
 *   runs in memory and clean up via the returned disposer
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EngineReport, TaskOutcomeRecord } from "../../src/orchestrator/engine";
import {
	type LiveSwarmRun,
	SwarmRunStore,
	buildResumePlan,
	clearLiveSwarmRuns,
	getActiveSwarmRun,
	listLiveSwarmRuns,
	registerLiveSwarmRun,
} from "../../src/orchestrator/run-store";
import type { OrchestratorPlan, UsageTotals } from "../../src/orchestrator/types";

function sampleUsage(totalTokens = 120): UsageTotals {
	return {
		inputTokens: 80,
		outputTokens: 40,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens,
		requests: 2,
		wallClockMs: 500,
	};
}

function samplePlan(id = "swarm-alpha"): OrchestratorPlan {
	return {
		id,
		goal: "Refactor authentication flow",
		workers: [{ id: "w1", roleLabel: "backend", backend: "native", isolated: true }],
		tasks: [
			{
				id: "setup",
				title: "Setup schema",
				description: "Create auth schema",
				dependencies: [],
				targetFiles: ["src/schema.ts"],
			},
			{
				id: "service",
				title: "Build auth service",
				description: "Implement token service",
				dependencies: ["setup"],
				targetFiles: ["src/service.ts"],
			},
			{
				id: "routes",
				title: "Wire auth routes",
				description: "Connect HTTP endpoints",
				dependencies: ["setup", "service"],
				targetFiles: ["src/routes.ts"],
			},
		],
	};
}

afterEach(() => {
	clearLiveSwarmRuns();
});

describe("SwarmRunStore", () => {
	test("persists run start, completion state, and per-task log diagnostics", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-run-store-"));
		try {
			let clock = 1_700_000_000_000;
			const store = new SwarmRunStore({ baseDir, now: () => clock });
			const plan = samplePlan("run-101");

			await store.saveRunStart(plan, "/workspace/app");
			const running = await store.loadRun("run-101");
			expect(running?.status).toBe("running");
			expect(running?.createdAt).toBe(1_700_000_000_000);
			expect(running?.tasks.setup?.state).toBe("pending");

			clock += 5_000;
			const outcomes = new Map<string, TaskOutcomeRecord>([
				[
					"setup",
					{
						state: "completed",
						workerId: "w1",
						outcome: {
							exitCode: 0,
							output: "schema created",
							changes: { branchName: "swarm/setup", hasChanges: true },
						},
					},
				],
				[
					"service",
					{
						state: "failed",
						workerId: "w1",
						outcome: {
							exitCode: 0,
							output: "wrote service",
						},
						error: "verification failed at typecheck (exit 2)",
						verification: {
							ok: false,
							firstFailure: "typecheck",
							checks: [
								{
									id: "typecheck",
									command: "bun check",
									ok: false,
									exitCode: 2,
									output: "error TS2322: Type mismatch",
									durationMs: 140,
								},
							],
						},
					},
				],
				[
					"routes",
					{
						state: "cancelled",
					},
				],
			]);

			const report: EngineReport = {
				planId: plan.id,
				usage: sampleUsage(350),
				outcomes,
				messages: [],
			};

			await store.saveRunComplete(plan, report, "/workspace/app");
			const completed = await store.loadRun("run-101");
			expect(completed?.status).toBe("failed");
			expect(completed?.createdAt).toBe(1_700_000_000_000);
			expect(completed?.updatedAt).toBe(1_700_000_005_000);
			expect(completed?.tasks.setup?.branchName).toBe("swarm/setup");
			expect(completed?.tasks.service?.error).toContain("typecheck");
			expect(completed?.usage.totalTokens).toBe(350);

			const serviceLog = await store.readTaskLog("run-101", "service");
			expect(serviceLog).toContain("wrote service");
			expect(serviceLog).toContain("error TS2322: Type mismatch");
		} finally {
			await fs.rm(baseDir, { recursive: true, force: true });
		}
	});

	test("lists persisted runs sorted newest first and honors limit", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-run-list-"));
		try {
			let clock = 1_000;
			const store = new SwarmRunStore({ baseDir, now: () => clock });

			const planA = samplePlan("plan-older");
			await store.saveRunStart(planA, "/repo");

			clock = 2_000;
			const planB = samplePlan("plan-newer");
			await store.saveRunStart(planB, "/repo");
			await store.saveRunComplete(
				planB,
				{
					planId: planB.id,
					usage: sampleUsage(),
					outcomes: new Map(
						planB.tasks.map(task => [
							task.id,
							{ state: "completed", workerId: "w1", outcome: { exitCode: 0, output: "done" } },
						]),
					),
					messages: [],
				},
				"/repo",
			);

			const all = await store.listRuns();
			expect(all.map(item => item.planId)).toEqual(["plan-newer", "plan-older"]);
			expect(all[0]?.status).toBe("completed");
			expect(all[0]?.completedTasks).toBe(3);
			expect(all[1]?.status).toBe("running");

			const limited = await store.listRuns(1);
			expect(limited).toHaveLength(1);
			expect(limited[0]?.planId).toBe("plan-newer");
		} finally {
			await fs.rm(baseDir, { recursive: true, force: true });
		}
	});

	test("returns null when loading a non-existent run and rejects path-traversal IDs", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-run-traversal-"));
		try {
			const store = new SwarmRunStore({ baseDir });
			expect(await store.loadRun("does-not-exist")).toBeNull();

			await expect(store.loadRun("../escape")).rejects.toThrow(/Invalid planId/);
			await expect(store.loadRun("nested/id")).rejects.toThrow(/Invalid planId/);
			await expect(store.loadRun("nested\\id")).rejects.toThrow(/Invalid planId/);
			await expect(store.saveRunStart({ ...samplePlan("../bad") }, "/repo")).rejects.toThrow(/Invalid planId/);
		} finally {
			await fs.rm(baseDir, { recursive: true, force: true });
		}
	});

	test("buildResumePlan strips completed tasks and their dependency edges, or returns null when done", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-run-resume-"));
		try {
			const store = new SwarmRunStore({ baseDir });
			const plan = samplePlan("plan-partial");

			await store.saveRunComplete(
				plan,
				{
					planId: plan.id,
					usage: sampleUsage(),
					outcomes: new Map<string, TaskOutcomeRecord>([
						["setup", { state: "completed", workerId: "w1", outcome: { exitCode: 0, output: "ok" } }],
						["service", { state: "failed", workerId: "w1", error: "build failed" }],
						["routes", { state: "cancelled" }],
					]),
					messages: [],
				},
				"/repo",
			);

			const loaded = await store.loadRun("plan-partial");
			expect(loaded).not.toBeNull();

			const resumed = store.buildResumePlan(loaded!);
			expect(resumed).not.toBeNull();
			expect(resumed?.tasks.map(task => task.id)).toEqual(["service", "routes"]);
			// "setup" completed, so "service" now has no blocking dependencies and "routes" only waits on "service".
			expect(resumed?.tasks[0]?.dependencies).toEqual([]);
			expect(resumed?.tasks[1]?.dependencies).toEqual(["service"]);

			// When every task is completed, buildResumePlan returns null.
			await store.saveRunComplete(
				plan,
				{
					planId: plan.id,
					usage: sampleUsage(),
					outcomes: new Map(
						plan.tasks.map(task => [
							task.id,
							{ state: "completed", workerId: "w1", outcome: { exitCode: 0, output: "ok" } },
						]),
					),
					messages: [],
				},
				"/repo",
			);
			const fullyCompleted = await store.loadRun("plan-partial");
			expect(buildResumePlan(fullyCompleted!)).toBeNull();
		} finally {
			await fs.rm(baseDir, { recursive: true, force: true });
		}
	});
});

describe("LiveSwarmRun registry", () => {
	test("registers, resolves active vs recent runs, and unregisters via disposer", () => {
		let firstActive = true;
		let secondActive = false;

		const run1: LiveSwarmRun = {
			planId: "live-1",
			goal: "First run",
			startedAt: 100,
			getSnapshot: () => [{ workerId: "w1", label: "w1", state: "running" }],
			stopAll: () => {
				firstActive = false;
			},
			isActive: () => firstActive,
		};

		const run2: LiveSwarmRun = {
			planId: "live-2",
			goal: "Second run",
			startedAt: 200,
			getSnapshot: () => [{ workerId: "w2", label: "w2", state: "completed" }],
			stopAll: () => {
				secondActive = false;
			},
			isActive: () => secondActive,
		};

		const dispose1 = registerLiveSwarmRun(run1);
		const dispose2 = registerLiveSwarmRun(run2);

		expect(listLiveSwarmRuns().map(run => run.planId)).toEqual(["live-2", "live-1"]);
		// Even though live-2 was registered later, live-1 is currently active so getActiveSwarmRun() prefers it.
		expect(getActiveSwarmRun()?.planId).toBe("live-1");
		expect(getActiveSwarmRun("live-2")?.planId).toBe("live-2");

		// Once live-1 finishes, getActiveSwarmRun() falls back to the most recent run (live-2).
		firstActive = false;
		expect(getActiveSwarmRun()?.planId).toBe("live-2");

		dispose2();
		expect(getActiveSwarmRun()?.planId).toBe("live-1");
		dispose1();
		expect(getActiveSwarmRun()).toBeUndefined();
	});
});
