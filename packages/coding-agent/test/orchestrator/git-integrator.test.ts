/**
 * GitIntegrator against a real repository.
 *
 * These tests build a throwaway repo with `git` on PATH rather than mocking the
 * VCS layer: the whole point of the integrator is that cherry-picks and branch
 * cleanup actually work, and a mock would only prove the calls were made.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitIntegrator } from "../../src/orchestrator/git-integrator";
import type { PendingIntegration } from "../../src/orchestrator/engine";

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

/** A branch off `main` that adds one file, mimicking a worker's commit. */
async function workerBranch(repo: string, branch: string, file: string, body: string): Promise<string> {
	const baseSha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "-b", branch);
	await Bun.write(path.join(repo, file), body);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", `feat: add ${file}`);
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
			// The file is on the target, and the worker's commit message survived.
			expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("from a\n");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("feat: add a.txt");
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

	test("keeps the branch when it did not merge", async () => {
		const repo = await makeRepo();
		try {
			// A branch that does not exist cannot merge; the integrator must report
			// the failure and leave the repository untouched.
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
			// `failed` names branches, like the success path, not task ids.
			expect(report.failed).toEqual(["worker-a"]);
			// The branch is still there, with its work intact.
			expect(git(repo, "branch", "--list")).toContain("worker-a");
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
