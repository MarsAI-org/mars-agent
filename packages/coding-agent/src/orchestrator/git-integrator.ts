/**
 * Integrator: lands the branches workers produced.
 *
 * Two responsibilities, kept together because they must agree on which
 * branches landed:
 *
 * 1. **Merge.** Cherry-pick each worker branch onto the target checkout in plan
 *    order, stopping at the first conflict so a half-applied series never looks
 *    like a clean integration.
 * 2. **Cleanup.** Delete the temporary branches and remove the worker
 *    worktrees, but only for branches whose commits are confirmed on the
 *    target. A branch that failed to land keeps its worktree, because that
 *    checkout is now the only copy of the work.
 *
 * A worker can also hand back a patch instead of a branch (when the branch
 * could not be created). Those are reported as failures with their patch path:
 * applying a patch is the caller's decision, not something to do silently.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md Milestone 3.
 */

import * as fs from "node:fs/promises";
import { logger } from "@marsai-org/utils";
import { cleanupTaskBranches, getRepoRoot, mergeTaskBranches } from "../task/worktree";
import type { IntegrationReport, Integrator, PendingIntegration } from "./engine";

export interface GitIntegratorOptions {
	/** Checkout the branches land on. Defaults to the repo root of `cwd`. */
	readonly cwd: string;
	/**
	 * Delete temporary branches and remove worktrees once their commits are on
	 * the target. Defaults to true; turn it off to inspect the result by hand.
	 */
	readonly cleanup?: boolean;
	/** Remove each branch's worktree, when one is still registered for it. */
	readonly removeWorktrees?: boolean;
}

export class GitIntegrator implements Integrator {
	readonly #options: GitIntegratorOptions;

	constructor(options: GitIntegratorOptions) {
		this.#options = options;
	}

	async integrate(pending: readonly PendingIntegration[], signal: AbortSignal): Promise<IntegrationReport> {
		if (pending.length === 0) return { merged: [], failed: [] };
		if (signal.aborted) {
			// `failed` carries branch names everywhere, so a caller never has to
			// ask which identifier it is holding.
			return {
				merged: [],
				failed: pending.map(entry => entry.branchName),
				summary: "integration cancelled",
			};
		}

		const repoRoot = await getRepoRoot(this.#options.cwd);
		const branches = pending.map(entry => ({
			branchName: entry.branchName,
			taskId: entry.taskId,
			...(entry.baseSha === undefined ? {} : { baseSha: entry.baseSha }),
		}));

		logger.debug("orchestration integration started", { repoRoot, branches: branches.length });
		const result = await mergeTaskBranches(repoRoot, branches);

		// A conflict stops the series: everything after it never ran, so those
		// branches are reported failed rather than silently dropped.
		const failed = [...result.failed];
		if (result.conflict) {
			logger.warn("orchestration integration hit a conflict", { conflict: result.conflict });
		}

		if (this.#options.cleanup !== false) {
			const landed = new Set(result.merged);
			await cleanupTaskBranches(repoRoot, result.merged);
			if (this.#options.removeWorktrees !== false) {
				for (const entry of pending) {
					if (!landed.has(entry.branchName)) continue;
					await removeWorktreeForBranch(repoRoot, entry.branchName);
				}
			}
		}

		return {
			merged: result.merged,
			failed,
			...(result.conflict === undefined
				? { summary: `${result.merged.length}/${pending.length} branches merged` }
				: { summary: `merged ${result.merged.length}/${pending.length}; conflict: ${result.conflict}` }),
		};
	}
}

/**
 * Remove the linked worktree registered for `branch`, when one exists.
 *
 * Best-effort by design: a worktree that cannot be removed must not fail an
 * integration whose commits already landed. The branch is already deleted by
 * the caller, so a leftover directory is inert rather than misleading.
 */
async function removeWorktreeForBranch(repoRoot: string, branch: string): Promise<void> {
	const list = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
	if (list.exitCode !== 0) return;

	let current: string | undefined;
	for (const line of list.stdout.toString("utf8").split("\n")) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length).trim();
			continue;
		}
		if (line.trim() !== `branch refs/heads/${branch}` || current === undefined) continue;
		const path = current;
		const removed = Bun.spawnSync(["git", "worktree", "remove", "--force", path], { cwd: repoRoot });
		if (removed.exitCode === 0) {
			logger.debug("orchestration integration removed worktree", { branch, path });
		} else {
			logger.debug("orchestration integration could not remove worktree", {
				branch,
				path,
				stderr: removed.stderr.toString("utf8").trim(),
			});
			// Fall back to deleting the directory: the branch is already gone, so
			// the checkout cannot be used for anything.
			await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
		}
		return;
	}
}
