/**
 * Verifier contracts (no test reaches a model):
 * - a green check list passes
 * - the first failing check stops the run and names itself
 * - output exceeding OUTPUT_LIMIT preserves the tail with a truncation header
 * - AbortSignal terminates an in-flight check immediately and skips remaining checks
 * - lexical and symlink cwd escapes outside the verification root are rejected
 * - per-check environment overrides reach the child command without leaking
 * - verifyBranchInTempWorktree verifies a branch in a detached worktree and always cleans it up
 * - a worker whose verification fails does not settle as completed
 * - a failed worker is not verified at all
 * - an engine without a verifier keeps the pre-verification behaviour
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@marsai-org/natives/vcs";
import { OrchestrationEngine, type EngineRunner, type WorkerRunContext } from "../../src/orchestrator/engine";
import type { OrchestratorPlan, WorkerOutcome, WorkerSpec } from "../../src/orchestrator/types";
import {
	NoopVerifier,
	OUTPUT_LIMIT,
	ShellVerifier,
	type VerificationCheck,
	type VerificationResult,
	type Verifier,
	describeVerification,
	verifyBranchInTempWorktree,
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

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
	}
	return proc.stdout.toString("utf8").trim();
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

	test("preserves the tail of output exceeding OUTPUT_LIMIT with a truncation prefix", async () => {
		const verifier = new ShellVerifier();
		// Emit > 8KB with a distinct head marker and a distinct tail summary at the end.
		const cmd = `node -e 'process.stdout.write("HEAD_MARKER\\n" + "x".repeat(${OUTPUT_LIMIT + 2048}) + "\\nTAIL_ERROR_SUMMARY\\n")'`;
		const result = await verifier.verify(process.cwd(), [{ id: "noisy", command: cmd }]);
		expect(result.ok).toBe(true);
		const output = result.checks[0]?.output ?? "";
		expect(output.startsWith("[truncated]...\n")).toBe(true);
		expect(output).not.toContain("HEAD_MARKER");
		expect(output.endsWith("TAIL_ERROR_SUMMARY\n")).toBe(true);
		expect(output.length).toBe("[truncated]...\n".length + OUTPUT_LIMIT);
	});

	test("passes per-check env variables to the check command", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [
			{
				id: "with-env",
				command: 'test "$MARS_CHECK_TOKEN" = "secret-42" && printf "%s" "$MARS_CHECK_TOKEN"',
				env: { MARS_CHECK_TOKEN: "secret-42" },
			},
			{
				id: "without-env",
				command: 'test -z "$MARS_CHECK_TOKEN"',
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.checks[0]?.output).toBe("secret-42");
	});

	test("rejects a check cwd that lexically escapes the verification root", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [{ id: "escape", command: "true", cwd: "../.." }]);
		expect(result.ok).toBe(false);
		expect(result.firstFailure).toBe("escape");
		expect(result.checks[0]?.failure).toContain("escapes root");
	});

	test("rejects a check cwd that escapes the verification root through a symlink", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-verify-root-"));
		const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-verify-outside-"));
		try {
			await fs.symlink(outsideDir, path.join(rootDir, "linked-outside"));
			const verifier = new ShellVerifier();
			const result = await verifier.verify(rootDir, [
				{ id: "symlink-escape", command: "true", cwd: "linked-outside" },
			]);
			expect(result.ok).toBe(false);
			expect(result.firstFailure).toBe("symlink-escape");
			expect(result.checks[0]?.failure).toContain("escapes root");
		} finally {
			await fs.rm(rootDir, { recursive: true, force: true });
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});

	test("times out a hanging check and reports timeout failure", async () => {
		const verifier = new ShellVerifier();
		const result = await verifier.verify(process.cwd(), [{ id: "hang", command: "sleep 10", timeoutSeconds: 0.1 }]);
		expect(result.ok).toBe(false);
		expect(result.firstFailure).toBe("hang");
		expect(result.checks[0]?.failure).toContain("timed out");
	});

	test("aborts an in-flight sleeping check immediately when AbortSignal fires", async () => {
		const verifier = new ShellVerifier();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 80);
		const startedAt = Date.now();
		try {
			const result = await verifier.verify(
				process.cwd(),
				[
					{ id: "sleeping", command: "sleep 30", timeoutSeconds: 30 },
					{ id: "never-runs", command: "true" },
				],
				controller.signal,
			);
			const elapsed = Date.now() - startedAt;
			expect(result.ok).toBe(false);
			expect(result.firstFailure).toBe("sleeping");
			expect(result.checks).toHaveLength(1);
			expect(result.checks[0]?.failure).toBe("aborted");
			expect(elapsed).toBeLessThan(5_000);
		} finally {
			clearTimeout(timer);
		}
	});

	test("verifyBranchInTempWorktree verifies branch contents in a temporary worktree and cleans it up", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mars-verify-wt-"));
		try {
			git(repo, "init", "-q", "-b", "main");
			git(repo, "config", "user.email", "test@example.com");
			git(repo, "config", "user.name", "Test");
			await Bun.write(path.join(repo, "base.txt"), "base\n");
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "init");

			git(repo, "checkout", "-q", "-b", "worker-feature");
			await Bun.write(path.join(repo, "feature.txt"), "verified-branch-content\n");
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "add feature");
			git(repo, "checkout", "-q", "main");

			const verifier = new ShellVerifier();
			const result = await verifyBranchInTempWorktree(
				repo,
				"worker-feature",
				[{ id: "check-feature", command: 'test "$(cat feature.txt)" = "verified-branch-content"' }],
				verifier,
			);

			expect(result.ok).toBe(true);
			expect(result.checks[0]?.ok).toBe(true);

			// Temporary worktree must be removed even after verification finishes.
			const vcsRepo = vcs.requireGit(repo);
			const worktrees = await vcsRepo.worktrees();
			expect(worktrees).toHaveLength(1);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
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
