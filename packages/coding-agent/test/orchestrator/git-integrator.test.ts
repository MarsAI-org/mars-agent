/**
 * GitIntegrator against a real repository.
 *
 * These tests build a throwaway repo with `git` on PATH rather than mocking the
 * VCS layer: the whole point of the integrator is that cherry-picks, worktree
 * removal before branch deletion, conflict fallback hooks, and mid-loop
 * cancellation actually work against real git state.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PendingIntegration } from "../../src/orchestrator/engine";
import { GitIntegrator } from "../../src/orchestrator/git-integrator";

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
	}
	return proc.stdout.toString("utf8").trim();
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-integrator-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	await Bun.write(path.join(dir, "base.txt"), "base\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

/** A branch off `main` that writes one file, mimicking a worker's commit. */
async function workerBranch(repo: string, branch: string, file: string, body: string): Promise<string> {
	const baseSha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "-b", branch);
	await Bun.write(path.join(repo, file), body);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", `feat: update ${file} on ${branch}`);
	git(repo, "checkout", "-q", "main");
	return baseSha;
}

async function cleanup(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true });
}

describe("GitIntegrator", () => {
	test("cherry-picks a worker branch onto the target and reports it merged", async () => {
		const repo = await makeRepo();
		try {
			const baseSha = await workerBranch(repo, "worker-a", "a.txt", "from a\n");
			const pending: PendingIntegration[] = [
				{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha, targetFiles: ["a.txt"] },
			];

			const report = await new GitIntegrator({ cwd: repo }).integrate(pending, new AbortController().signal);

			expect(report.merged).toEqual(["worker-a"]);
			expect(report.failed).toEqual([]);
			expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("from a\n");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("feat: update a.txt on worker-a");
		} finally {
			await cleanup(repo);
		}
	});

	test("deletes the branch once its commits are on the target", async () => {
		const repo = await makeRepo();
		try {
			const baseSha = await workerBranch(repo, "worker-a", "a.txt", "x\n");
			await new GitIntegrator({ cwd: repo }).integrate(
				[{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha, targetFiles: [] }],
				new AbortController().signal,
			);

			const branches = git(repo, "branch", "--list");
			expect(branches).not.toContain("worker-a");
		} finally {
			await cleanup(repo);
		}
	});

	test("removes a linked worktree before deleting its checked-out branch", async () => {
		const repo = await makeRepo();
		const wtDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-linked-wt-"));
		const worktreePath = path.join(wtDir, "worker-wt");
		try {
			const baseSha = git(repo, "rev-parse", "HEAD");
			git(repo, "worktree", "add", "-q", "-b", "worker-wt", worktreePath, "main");
			await Bun.write(path.join(worktreePath, "wt.txt"), "from linked worktree\n");
			git(worktreePath, "add", ".");
			git(worktreePath, "commit", "-q", "-m", "feat: commit in linked worktree");

			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[{ taskId: "wt", workerId: "w1", branchName: "worker-wt", baseSha, targetFiles: ["wt.txt"] }],
				new AbortController().signal,
			);

			expect(report.merged).toEqual(["worker-wt"]);
			expect(report.failed).toEqual([]);
			expect(await Bun.file(path.join(repo, "wt.txt")).text()).toBe("from linked worktree\n");
			// If cleanupTaskBranches ran before removeWorktreeForBranch, git would refuse to delete worker-wt.
			expect(git(repo, "branch", "--list")).not.toContain("worker-wt");
			expect(git(repo, "worktree", "list")).not.toContain(worktreePath);
		} finally {
			await cleanup(wtDir);
			await cleanup(repo);
		}
	});

	test("keeps the branch when it did not merge", async () => {
		const repo = await makeRepo();
		try {
			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[{ taskId: "ghost", workerId: "w1", branchName: "no-such-branch", targetFiles: [] }],
				new AbortController().signal,
			);

			expect(report.merged).toEqual([]);
			expect(report.failed).toEqual(["no-such-branch"]);
			expect(report.summary).toContain("conflict");
		} finally {
			await cleanup(repo);
		}
	});

	test("stops on a two-branch cherry-pick conflict and preserves the conflicting branch", async () => {
		const repo = await makeRepo();
		try {
			const baseA = await workerBranch(repo, "worker-a", "base.txt", "line from worker-a\n");
			const baseB = await workerBranch(repo, "worker-b", "base.txt", "conflicting line from worker-b\n");
			const baseC = await workerBranch(repo, "worker-c", "c.txt", "from c\n");

			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[
					{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha: baseA, targetFiles: ["base.txt"] },
					{ taskId: "b", workerId: "w2", branchName: "worker-b", baseSha: baseB, targetFiles: ["base.txt"] },
					{ taskId: "c", workerId: "w3", branchName: "worker-c", baseSha: baseC, targetFiles: ["c.txt"] },
				],
				new AbortController().signal,
			);

			expect(report.merged).toEqual(["worker-a"]);
			expect(report.failed).toEqual(["worker-b", "worker-c"]);
			expect(report.summary).toContain("conflict: worker-b:");
			expect(await Bun.file(path.join(repo, "base.txt")).text()).toBe("line from worker-a\n");
			// Landed branch is deleted; unmerged conflicting and subsequent branches are preserved.
			const branches = git(repo, "branch", "--list");
			expect(branches).not.toContain("worker-a");
			expect(branches).toContain("worker-b");
			expect(branches).toContain("worker-c");
		} finally {
			await cleanup(repo);
		}
	});

	test("invokes resolveConflict on a cherry-pick conflict and continues when resolved", async () => {
		const repo = await makeRepo();
		try {
			const baseA = await workerBranch(repo, "worker-a", "base.txt", "line from worker-a\n");
			const baseB = await workerBranch(repo, "worker-b", "base.txt", "line from worker-b\n");
			const baseC = await workerBranch(repo, "worker-c", "c.txt", "from c\n");

			const conflictsSeen: string[] = [];
			const integrator = new GitIntegrator({
				cwd: repo,
				resolveConflict: async (entry, conflict) => {
					conflictsSeen.push(`${entry.branchName}:${conflict}`);
					await Bun.write(path.join(repo, "base.txt"), "line from worker-a\nline from worker-b\n");
					git(repo, "add", "base.txt");
					git(repo, "commit", "-q", "-m", "chore: resolve worker-b conflict");
					return { resolved: true, detail: "combined both lines" };
				},
			});

			const report = await integrator.integrate(
				[
					{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha: baseA, targetFiles: ["base.txt"] },
					{ taskId: "b", workerId: "w2", branchName: "worker-b", baseSha: baseB, targetFiles: ["base.txt"] },
					{ taskId: "c", workerId: "w3", branchName: "worker-c", baseSha: baseC, targetFiles: ["c.txt"] },
				],
				new AbortController().signal,
			);

			expect(conflictsSeen).toHaveLength(1);
			expect(conflictsSeen[0]).toContain("worker-b");
			expect(report.merged).toEqual(["worker-a", "worker-b", "worker-c"]);
			expect(report.failed).toEqual([]);
			expect(await Bun.file(path.join(repo, "base.txt")).text()).toBe("line from worker-a\nline from worker-b\n");
			expect(await Bun.file(path.join(repo, "c.txt")).text()).toBe("from c\n");
			expect(git(repo, "branch", "--list")).not.toContain("worker-b");
		} finally {
			await cleanup(repo);
		}
	});

	test("stops the series and keeps worktree when resolveConflict returns resolved: false", async () => {
		const repo = await makeRepo();
		try {
			const baseA = await workerBranch(repo, "worker-a", "base.txt", "line from worker-a\n");
			const baseB = await workerBranch(repo, "worker-b", "base.txt", "line from worker-b\n");

			const integrator = new GitIntegrator({
				cwd: repo,
				resolveConflict: async () => ({ resolved: false, detail: "manual merge needed" }),
			});

			const report = await integrator.integrate(
				[
					{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha: baseA, targetFiles: ["base.txt"] },
					{ taskId: "b", workerId: "w2", branchName: "worker-b", baseSha: baseB, targetFiles: ["base.txt"] },
				],
				new AbortController().signal,
			);

			expect(report.merged).toEqual(["worker-a"]);
			expect(report.failed).toEqual(["worker-b"]);
			expect(report.summary).toContain("manual merge needed");
			expect(git(repo, "branch", "--list")).toContain("worker-b");
		} finally {
			await cleanup(repo);
		}
	});

	test("stops mid-loop when signal is aborted and marks remaining branches failed", async () => {
		const repo = await makeRepo();
		try {
			const baseA = await workerBranch(repo, "worker-a", "base.txt", "from a\n");
			const baseB = await workerBranch(repo, "worker-b", "base.txt", "conflict on b\n");
			const baseC = await workerBranch(repo, "worker-c", "c.txt", "from c\n");

			const controller = new AbortController();
			const integrator = new GitIntegrator({
				cwd: repo,
				resolveConflict: async () => {
					// Resolve branch B but abort the signal before branch C starts.
					controller.abort();
					return { resolved: true, detail: "resolved before abort" };
				},
			});

			const report = await integrator.integrate(
				[
					{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha: baseA, targetFiles: ["base.txt"] },
					{ taskId: "b", workerId: "w2", branchName: "worker-b", baseSha: baseB, targetFiles: ["base.txt"] },
					{ taskId: "c", workerId: "w3", branchName: "worker-c", baseSha: baseC, targetFiles: ["c.txt"] },
				],
				controller.signal,
			);

			expect(report.merged).toEqual(["worker-a", "worker-b"]);
			expect(report.failed).toEqual(["worker-c"]);
			expect(report.summary).toContain("integration cancelled");
			expect(git(repo, "branch", "--list")).toContain("worker-c");
		} finally {
			await cleanup(repo);
		}
	});

	test("merges two independent branches, both landing", async () => {
		const repo = await makeRepo();
		try {
			const baseA = await workerBranch(repo, "worker-a", "a.txt", "a\n");
			const baseB = await workerBranch(repo, "worker-b", "b.txt", "b\n");

			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[
					{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha: baseA, targetFiles: ["a.txt"] },
					{ taskId: "b", workerId: "w2", branchName: "worker-b", baseSha: baseB, targetFiles: ["b.txt"] },
				],
				new AbortController().signal,
			);

			expect(report.merged).toEqual(["worker-a", "worker-b"]);
			expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("a\n");
			expect(await Bun.file(path.join(repo, "b.txt")).text()).toBe("b\n");
		} finally {
			await cleanup(repo);
		}
	});

	test("a cancelled signal integrates nothing", async () => {
		const repo = await makeRepo();
		try {
			const baseSha = await workerBranch(repo, "worker-a", "a.txt", "x\n");
			const controller = new AbortController();
			controller.abort();

			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[{ taskId: "a", workerId: "w1", branchName: "worker-a", baseSha, targetFiles: [] }],
				controller.signal,
			);

			expect(report.merged).toEqual([]);
			expect(report.failed).toEqual(["worker-a"]);
			expect(git(repo, "branch", "--list")).toContain("worker-a");
		} finally {
			await cleanup(repo);
		}
	});

	test("never deletes the primary worktree when a branch matches the current checkout", async () => {
		const repo = await makeRepo();
		try {
			const baseSha = git(repo, "rev-parse", "HEAD");
			const report = await new GitIntegrator({ cwd: repo }).integrate(
				[{ taskId: "main-task", workerId: "w1", branchName: "main", baseSha, targetFiles: [] }],
				new AbortController().signal,
			);

			expect(report.merged).toEqual(["main"]);
			expect(await Bun.file(path.join(repo, "base.txt")).text()).toBe("base\n");
		} finally {
			await cleanup(repo);
		}
	});

	test("an empty plan touches nothing", async () => {
		const repo = await makeRepo();
		try {
			const before = git(repo, "rev-parse", "HEAD");
			const report = await new GitIntegrator({ cwd: repo }).integrate([], new AbortController().signal);
			expect(report).toEqual({ merged: [], failed: [] });
			expect(git(repo, "rev-parse", "HEAD")).toBe(before);
		} finally {
			await cleanup(repo);
		}
	});
});
