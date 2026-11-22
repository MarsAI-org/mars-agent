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
import * as path from "node:path";
import type { VcsWorktreeEntry } from "@marsai-org/natives";
import * as vcs from "@marsai-org/natives/vcs";
import { getWorktreesDir, logger } from "@marsai-org/utils";
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
async function isSafeLinkedWorktreeFallback(
	worktreePath: string,
	primaryRoot: string,
	resolvedRepoRoot: string,
): Promise<boolean> {
	if (worktreePath === primaryRoot || worktreePath === resolvedRepoRoot) return false;
	const worktreeBase = path.resolve(getWorktreesDir());
	const relToBase = path.relative(worktreeBase, worktreePath);
	if (relToBase === "" || relToBase.startsWith("..") || path.isAbsolute(relToBase)) {
		return false;
	}
	try {
		const gitEntry = path.join(worktreePath, ".git");
		const stat = await fs.lstat(gitEntry);
		if (!stat.isFile()) return false;
		const content = await Bun.file(gitEntry).text();
		return content.startsWith("gitdir:");
	} catch {
		return false;
	}
}

async function removeWorktreeForBranch(repoRoot: string, branch: string): Promise<void> {
	const repo = vcs.git(repoRoot);
	if (!repo) return;

	let entries: VcsWorktreeEntry[];
	try {
		entries = await repo.worktrees();
	} catch {
		return;
	}

	const primaryRoot = path.resolve(repo.primaryRoot());
	const resolvedRepoRoot = path.resolve(repoRoot);
	const expectedRef = `refs/heads/${branch}`;

	// Entry 0 in `git worktree list` is always the primary/main worktree; never touch it.
	for (let i = 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.branch !== expectedRef && entry.branch !== branch) continue;

		const worktreePath = path.resolve(entry.path);
		if (worktreePath === primaryRoot || worktreePath === resolvedRepoRoot) continue;

		try {
			const removed = await repo.worktreeRemove(worktreePath, true);
			if (removed) {
				logger.debug("orchestration integration removed worktree", { branch, path: worktreePath });
				return;
			}
			logger.debug("orchestration integration could not remove worktree", { branch, path: worktreePath });
		} catch (error) {
			logger.debug("orchestration integration could not remove worktree", {
				branch,
				path: worktreePath,
				stderr: vcs.isVcsError(error) ? error.stderr.trim() : String(error),
			});
		}

		// Fall back to deleting the directory only when verified as a linked worktree
		// under the managed worktree base directory — never risk removing the primary checkout.
		if (await isSafeLinkedWorktreeFallback(worktreePath, primaryRoot, resolvedRepoRoot)) {
			await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
		}
		return;
	}
}
