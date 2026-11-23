/**
 * Contracts for `spec-loader.ts`:
 * - parses YAML and JSON swarm specs into canonical SwarmSpec objects
 * - normalizes legacy snake_case aliases (`waits_for`, `target_files`, `worker`,
 *   `role`, `role_label`, `tools`, `target_count`, `verification_checks`)
 * - rejects malformed specs (missing goal/tasks, duplicate IDs, unknown deps,
 *   self-dependencies, dependency cycles, invalid mode, invalid iterations)
 * - compiles DAG and pipeline specs into OrchestratorPlan instances
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSwarmSpec, parseSwarmSpec, specToOrchestratorPlan } from "../../src/orchestrator/spec-loader";

describe("parseSwarmSpec & loadSwarmSpec", () => {
	test("parses canonical YAML spec and compiles to a DAG OrchestratorPlan", () => {
		const yaml = `
name: Auth Overhaul
goal: Migrate auth endpoints to JWT
mode: dag
maxConcurrency: 3
maxRetries: 2
isolated: true
verificationChecks:
  - bun check
  - bun test
workers:
  - id: api-worker
    roleLabel: backend
    requestedTools: [read, edit, bash]
    model: sonnet
    isolated: true
tasks:
  - id: schema
    title: Update user schema
    description: Add refresh token column
    targetFiles:
      - src/db/schema.ts
    agent: api-worker
  - id: handler
    title: Update login handler
    description: Issue JWT and refresh token
    dependencies:
      - schema
    targetFiles:
      - src/api/login.ts
    agent: api-worker
`;
		const spec = parseSwarmSpec(yaml, "yaml");
		expect(spec.name).toBe("Auth Overhaul");
		expect(spec.goal).toBe("Migrate auth endpoints to JWT");
		expect(spec.mode).toBe("dag");
		expect(spec.iterations).toBe(1);
		expect(spec.maxConcurrency).toBe(3);
		expect(spec.maxRetries).toBe(2);
		expect(spec.isolated).toBe(true);
		expect(spec.verificationChecks).toEqual(["bun check", "bun test"]);
		expect(spec.workers).toEqual([
			{
				id: "api-worker",
				roleLabel: "backend",
				backend: "native",
				requestedTools: ["read", "edit", "bash"],
				model: "sonnet",
				isolated: true,
			},
		]);

		const plan = specToOrchestratorPlan(spec);
		expect(plan.id).toBe("swarm-auth-overhaul");
		expect(plan.goal).toBe("Migrate auth endpoints to JWT");
		expect(plan.tasks).toHaveLength(2);
		expect(plan.tasks[1]?.dependencies).toEqual(["schema"]);
		expect(plan.workers[0]?.roleLabel).toBe("backend");
	});

	test("supports legacy aliases in YAML and JSON specs", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-spec-loader-"));
		try {
			const yamlPath = path.join(tmpDir, "legacy.yaml");
			await Bun.write(
				yamlPath,
				`
goal: Run legacy pipeline
mode: pipeline
target_count: 3
verification_checks:
  - bun test
workers:
  - id: w-1
    role: reviewer
    tools: [read, grep]
  - id: w-2
    role_label: fixer
tasks:
  - id: audit
    title: Audit module
    description: Find issues
    target_files: [src/index.ts]
    worker: w-1
  - id: patch
    title: Patch module
    description: Fix issues
    waits_for: [audit]
    target_files: [src/index.ts]
    worker: w-2
`,
			);

			const spec = await loadSwarmSpec(yamlPath);
			expect(spec.mode).toBe("pipeline");
			expect(spec.iterations).toBe(3);
			expect(spec.verificationChecks).toEqual(["bun test"]);
			expect(spec.workers[0]?.roleLabel).toBe("reviewer");
			expect(spec.workers[0]?.requestedTools).toEqual(["read", "grep"]);
			expect(spec.workers[1]?.roleLabel).toBe("fixer");
			expect(spec.tasks[0]?.targetFiles).toEqual(["src/index.ts"]);
			expect(spec.tasks[0]?.agent).toBe("w-1");
			expect(spec.tasks[1]?.dependencies).toEqual(["audit"]);
			expect(spec.tasks[1]?.agent).toBe("w-2");

			const jsonPath = path.join(tmpDir, "spec.json");
			await Bun.write(
				jsonPath,
				JSON.stringify({
					name: "json-pipeline",
					goal: "Sequential passes",
					mode: "pipeline",
					iterations: 2,
					tasks: [
						{ id: "step-1", title: "Step 1", description: "First pass step" },
						{ id: "step-2", title: "Step 2", description: "Second pass step" },
					],
				}),
			);

			const jsonSpec = await loadSwarmSpec(jsonPath);
			expect(jsonSpec.workers).toHaveLength(1);
			expect(jsonSpec.workers[0]?.id).toBe("worker-1");

			// Pipeline mode with no explicit dependencies auto-chains step-2 after step-1.
			const iter2Plan = specToOrchestratorPlan(jsonSpec, 2);
			expect(iter2Plan.id).toBe("swarm-json-pipeline-iter-2");
			expect(iter2Plan.goal).toBe("Sequential passes (iteration 2/2)");
			expect(iter2Plan.tasks[0]?.dependencies).toEqual([]);
			expect(iter2Plan.tasks[1]?.dependencies).toEqual(["step-1"]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rejects malformed specs with descriptive errors", () => {
		expect(() => parseSwarmSpec("", "yaml")).toThrow(/empty/i);
		expect(() => parseSwarmSpec("goal: ''\ntasks: []", "yaml")).toThrow(/goal/i);
		expect(() => parseSwarmSpec("goal: build\ntasks: []", "yaml")).toThrow(/tasks/i);

		// Duplicate task IDs
		expect(() =>
			parseSwarmSpec(
				`
goal: dup tasks
tasks:
  - id: t1
    title: One
  - id: t1
    title: Two
`,
				"yaml",
			),
		).toThrow(/duplicate task id "t1"/i);

		// Duplicate worker IDs
		expect(() =>
			parseSwarmSpec(
				`
goal: dup workers
workers:
  - id: w1
  - id: w1
tasks:
  - id: t1
    title: One
`,
				"yaml",
			),
		).toThrow(/duplicate worker id "w1"/i);

		// Unknown dependency
		expect(() =>
			parseSwarmSpec(
				`
goal: unknown dep
tasks:
  - id: t1
    title: One
    dependencies: [ghost]
`,
				"yaml",
			),
		).toThrow(/unknown task "ghost"/i);

		// Self dependency
		expect(() =>
			parseSwarmSpec(
				`
goal: self dep
tasks:
  - id: t1
    title: One
    waits_for: [t1]
`,
				"yaml",
			),
		).toThrow(/depends on itself/i);

		// Dependency cycle
		expect(() =>
			parseSwarmSpec(
				`
goal: cycle
tasks:
  - id: a
    title: A
    dependencies: [b]
  - id: b
    title: B
    dependencies: [a]
`,
				"yaml",
			),
		).toThrow(/cycle/i);

		// Invalid mode and iterations
		expect(() =>
			parseSwarmSpec(
				`
goal: bad mode
mode: random
tasks:
  - id: a
    title: A
`,
				"yaml",
			),
		).toThrow(/mode/i);

		expect(() =>
			parseSwarmSpec(
				`
goal: bad iterations
iterations: 0
tasks:
  - id: a
    title: A
`,
				"yaml",
			),
		).toThrow(/iterations/i);
	});
});
