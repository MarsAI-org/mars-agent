import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSwarmCliCommand } from "@marsai-org/coding-agent/commands/swarm";
import { SwarmRunStore } from "@marsai-org/coding-agent/orchestrator/run-store";
import type { OrchestratorPlan } from "@marsai-org/coding-agent/orchestrator/types";

const SAMPLE_YAML_SPEC = `
name: sample-feature
goal: Build and verify sample feature
mode: dag
maxConcurrency: 3
workers:
  - id: backend
    roleLabel: Backend Worker
    agent: task
    model: "@smol"
    tools:
      - read
      - edit
    isolated: true
  - id: qa
    roleLabel: QA Worker
    isolated: false
tasks:
  - id: impl
    title: Implement feature
    description: Write src/feature.ts
    targetFiles:
      - src/feature.ts
    worker: backend
  - id: test
    title: Test feature
    description: Write test/feature.test.ts
    dependencies:
      - impl
    targetFiles:
      - test/feature.test.ts
    worker: qa
`;

describe("mars swarm headless CLI", () => {
	it("validates a declarative YAML spec and prints the resolved DAG plan and workers", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-swarm-cli-validate-"));
		try {
			const specFile = path.join(tempDir, "swarm.yaml");
			await Bun.write(specFile, SAMPLE_YAML_SPEC);

			const result = await runSwarmCliCommand({
				action: "validate",
				target: specFile,
				cwd: tempDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Valid swarm spec:");
			expect(result.output).toContain("Plan: swarm-sample-feature");
			expect(result.output).toContain("backend (Backend Worker)");
			expect(result.output).toContain("impl: Implement feature");
			expect(result.output).toContain("test: Test feature worker=qa deps=[impl]");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("supports mars swarm run --dry-run with worker and mode overrides without invoking models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-swarm-cli-dryrun-"));
		try {
			const specFile = path.join(tempDir, "swarm.yaml");
			await Bun.write(specFile, SAMPLE_YAML_SPEC);

			const result = await runSwarmCliCommand({
				action: "run",
				target: specFile,
				cwd: tempDir,
				dryRun: true,
				workers: 6,
				mode: "parallel",
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Dry run (1 pass(es)):");
			expect(result.output).toContain("Fan-out policy: parallel");
			expect(result.output).toContain("Max concurrent workers: 6");
			expect(result.output).toContain("Plan: swarm-sample-feature");

			const invalidWorkers = await runSwarmCliCommand({
				action: "run",
				target: specFile,
				cwd: tempDir,
				dryRun: true,
				workers: 99,
			});
			expect(invalidWorkers.exitCode).toBe(1);
			expect(invalidWorkers.output).toContain("between 1 and 64");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("lists persisted runs, reports detailed run status, and computes resume --dry-run plans", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-swarm-cli-store-"));
		try {
			const store = new SwarmRunStore({ baseDir: tempDir, now: () => 1_700_000_050_000 });

			const emptyList = await runSwarmCliCommand({
				action: "list",
				store,
			});
			expect(emptyList.exitCode).toBe(0);
			expect(emptyList.output).toBe("No persisted swarm runs found.");

			const plan: OrchestratorPlan = {
				id: "swarm-partial-run",
				goal: "Partial migration run",
				workers: [{ id: "w1", roleLabel: "Worker 1", backend: "native", isolated: false }],
				tasks: [
					{
						id: "step-1",
						title: "Step 1",
						description: "First step",
						dependencies: [],
						targetFiles: ["a.ts"],
					},
					{
						id: "step-2",
						title: "Step 2",
						description: "Second step depending on step-1",
						dependencies: ["step-1"],
						targetFiles: ["b.ts"],
					},
				],
			};

			await store.saveRunStart(plan, tempDir);
			await store.saveRunComplete(
				plan,
				{
					planId: plan.id,
					stoppedReason: "verification failed",
					usage: {
						inputTokens: 120,
						outputTokens: 80,
						reasoningTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 200,
						requests: 2,
						wallClockMs: 450,
					},
					outcomes: new Map([
						[
							"step-1",
							{
								state: "completed",
								workerId: "w1",
								outcome: { exitCode: 0, output: "step 1 done" },
							},
						],
						[
							"step-2",
							{
								state: "failed",
								workerId: "w1",
								error: "typecheck failed",
								outcome: { exitCode: 1, output: "error TS2322", error: "typecheck failed" },
							},
						],
					]),
					messages: [],
				},
				tempDir,
			);

			const listResult = await runSwarmCliCommand({
				action: "list",
				store,
			});
			expect(listResult.exitCode).toBe(0);
			expect(listResult.output).toContain("swarm-partial-run");
			expect(listResult.output).toContain("[failed]");
			expect(listResult.output).toContain("1/2 completed (1 failed)");

			const statusResult = await runSwarmCliCommand({
				action: "status",
				target: "swarm-partial-run",
				store,
			});
			expect(statusResult.exitCode).toBe(0);
			expect(statusResult.output).toContain("Plan: swarm-partial-run");
			expect(statusResult.output).toContain("Status: failed (verification failed)");
			expect(statusResult.output).toContain("[completed] step-1: Step 1");
			expect(statusResult.output).toContain("[failed] step-2: Step 2");
			expect(statusResult.output).toContain("error: typecheck failed");
			expect(statusResult.output).toContain("200 tokens");

			const resumeDryRun = await runSwarmCliCommand({
				action: "resume",
				target: "swarm-partial-run",
				dryRun: true,
				store,
			});
			expect(resumeDryRun.exitCode).toBe(0);
			expect(resumeDryRun.output).toContain("Dry run resume for swarm-partial-run (1 remaining task(s)):");
			expect(resumeDryRun.output).toContain("step-2: Step 2");
			// Completed step-1 must be stripped from the resume plan and from step-2's dependencies.
			expect(resumeDryRun.output).not.toContain("step-1: Step 1");
			expect(resumeDryRun.output).not.toContain("deps=[step-1]");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
