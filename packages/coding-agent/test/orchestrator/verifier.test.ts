/**
 * Verifier contracts (no test reaches a model, no test spawns a real check
 * except the one shell case that uses `true`/`false`):
 * - a green check list passes
 * - the first failing check stops the run and names itself
 * - a worker whose verification fails does not settle as completed
 * - a failed worker is not verified at all
 * - an engine without a verifier keeps the pre-verification behaviour
 */

import { describe, expect, test } from "bun:test";
import { OrchestrationEngine, type EngineRunner, type WorkerRunContext } from "../../src/orchestrator/engine";
import type { OrchestratorPlan, WorkerOutcome, WorkerSpec } from "../../src/orchestrator/types";
import {
	type CheckResult,
	type VerificationCheck,
	type VerificationResult,
	type Verifier,
	NoopVerifier,
	ShellVerifier,
	describeVerification,
} from "../../src/orchestrator/verifier";

class FakeVerifier implements Verifier {
	calls: string[] = [];
	constructor(private readonly result: VerificationResult) {}
	async verify(root: string, _checks: readonly VerificationCheck[]): Promise<VerificationResult> {
		this.calls.push(root);
		return this.result;
	}
}

class InstantRunner implements EngineRunner {
	constructor(private readonly outcome: WorkerOutcome = { exitCode: 0, output: "ok" }) {}
	async run(_spec: WorkerSpec, _task: { id: string }, _context: WorkerRunContext): Promise<WorkerOutcome> {
		return this.outcome;
	}
}

function worker(id: string): WorkerSpec {
	return { id, roleLabel: id, backend: "native", isolated: false };
}

function plan(tasks: readonly OrchestratorPlan["tasks"][number][]): OrchestratorPlan {
	return { id: "plan-verify", goal: "verify", tasks, workers: [worker("w1")] };
}

function task(id: string): OrchestratorPlan["tasks"][number] {
	return { id, title: id, description: `do ${id}`, dependencies: [], targetFiles: [] };
}

const PASS: VerificationResult = { ok: true, checks: [] };
const FAIL: VerificationResult = {
	ok: false,
	checks: [
		{
			id: "typecheck",
			command: "tsgo",
			ok: false,
			exitCode: 2,
			output: "error TS1",
			durationMs: 1,
		},
	],
	firstFailure: "typecheck",
};

const CHECKS: readonly VerificationCheck[] = [{ id: "typecheck", command: "tsgo --noEmit" }];

describe("verifier", () => {
	test("passes when every check exits zero", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [{ id: "ok", command: "true" }]);
		expect(result.ok).toBe(true);
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]?.exitCode).toBe(0);
	});

	test("stops at the first failure and names it", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [
			{ id: "first", command: "true" },
			{ id: "second", command: "false" },
			{ id: "third", command: "true" },
		]);
		expect(result.ok).toBe(false);
		expect(result.firstFailure).toBe("second");
		// The check after the failure never ran.
		expect(result.checks.map(check => check.id)).toEqual(["first", "second"]);
	});

	test("captures output for a failing check", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [{ id: "echo", command: "echo boom >&2; exit 3" }]);
		expect(result.ok).toBe(false);
		expect(result.checks[0]?.output).toContain("boom");
		expect(result.checks[0]?.exitCode).toBe(3);
	});

	test("no-op verifier accepts everything without running anything", async () => {
		const result = await new NoopVerifier().verify("/nowhere", CHECKS);
		expect(result.ok).toBe(true);
		expect(result.checks).toEqual([]);
	});

	test("describes a failure in one line", () => {
		expect(describeVerification(PASS)).toBe("verification passed");
		expect(describeVerification(FAIL)).toContain("typecheck");
	});
});

describe("engine verification gate", () => {
	test("a worker whose verification fails does not settle as completed", async () => {
		const verifier = new FakeVerifier(FAIL);
		const engine = new OrchestrationEngine({
			runner: new InstantRunner(),
			verifier,
			verificationChecks: CHECKS,
			verificationRoot: "/tmp/tree",
		});
		const report = await engine.run(plan([task("a")]));
		expect(verifier.calls).toEqual(["/tmp/tree"]);
		expect(report.outcomes.get("a")?.state).toBe("failed");
	});

	test("a worker whose verification passes settles as completed", async () => {
		const verifier = new FakeVerifier(PASS);
		const engine = new OrchestrationEngine({
			runner: new InstantRunner(),
			verifier,
			verificationChecks: CHECKS,
			verificationRoot: "/tmp/tree",
		});
		const report = await engine.run(plan([task("a")]));
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("a failed worker is never verified", async () => {
		const verifier = new FakeVerifier(PASS);
		const engine = new OrchestrationEngine({
			runner: new InstantRunner({ exitCode: 1, output: "", error: "boom" }),
			verifier,
			verificationChecks: CHECKS,
		});
		const report = await engine.run(plan([task("a")]));
		expect(verifier.calls).toEqual([]);
		expect(report.outcomes.get("a")?.state).toBe("failed");
	});

	test("no checks configured means no verification call", async () => {
		const verifier = new FakeVerifier(FAIL);
		const engine = new OrchestrationEngine({ runner: new InstantRunner(), verifier });
		const report = await engine.run(plan([task("a")]));
		expect(verifier.calls).toEqual([]);
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("an engine without a verifier keeps the old behaviour", async () => {
		const engine = new OrchestrationEngine({ runner: new InstantRunner() });
		const report = await engine.run(plan([task("a")]));
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("verification failure blocks a dependent task", async () => {
		const verifier = new FakeVerifier(FAIL);
		const engine = new OrchestrationEngine({
			runner: new InstantRunner(),
			verifier,
			verificationChecks: CHECKS,
		});
		const dependent = { ...task("b"), dependencies: ["a"] };
		const report = await engine.run(plan([task("a"), dependent]));
		expect(report.outcomes.get("a")?.state).toBe("failed");
		expect(report.outcomes.get("b")?.state).toBe("cancelled");
	});
});

/** Keep the unused import meaningful for the type checker in strict builds. */
export type { CheckResult };
