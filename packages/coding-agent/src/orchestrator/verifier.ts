/**
 * Verification seam for orchestrated worker output.
 *
 * A worker that reports success has only told us its process exited zero. That
 * says nothing about whether the code it wrote builds, lints, or passes the
 * tests it touched. The verifier runs a configured check list and returns a
 * verdict the engine uses to decide whether the task may settle as completed.
 *
 * The check list is configuration, not a hardcoded guess: a caller supplies the
 * commands, and the verifier only decides pass/fail and surfaces diagnostics.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md, Milestone 3.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@marsai-org/natives/vcs";
import { getWorktreesDir, isEnoent, ptree } from "@marsai-org/utils";

/** One command the verifier runs. */
export interface VerificationCheck {
	/** Stable identifier, used in reports and for per-check overrides. */
	readonly id: string;
	/** Shell command line, run through `sh -c` (or `cmd /c` on Windows). */
	readonly command: string;
	/** Working directory, relative to the verification root. Defaults to the root. */
	readonly cwd?: string;
	/** Extra environment for this check only. */
	readonly env?: Readonly<Record<string, string>>;
	/** Seconds before this check is killed. Defaults to 600. */
	readonly timeoutSeconds?: number;
}

/** Outcome of one check. */
export interface CheckResult {
	readonly id: string;
	readonly command: string;
	readonly ok: boolean;
	/** Exit code, or null when the process was killed or failed to spawn. */
	readonly exitCode: number | null;
	/** Combined stdout/stderr, truncated to a diagnostic budget. */
	readonly output: string;
	readonly durationMs: number;
	/** Why the check did not produce a verdict (timeout, spawn failure). */
	readonly failure?: string;
}

/** Verdict for one verification run. */
export interface VerificationResult {
	readonly ok: boolean;
	readonly checks: readonly CheckResult[];
	/** First failing check's id, for a one-line summary. */
	readonly firstFailure?: string;
}

/** Runs a check list against a directory. Injected so tests never spawn processes. */
export interface Verifier {
	verify(root: string, checks: readonly VerificationCheck[], signal?: AbortSignal): Promise<VerificationResult>;
}

/** Output kept per check; enough to diagnose without flooding the transcript. */
export const OUTPUT_LIMIT = 8_000;

/** Prefix prepended when check output exceeds `OUTPUT_LIMIT` and is tail-truncated. */
const TRUNCATED_PREFIX = "[truncated]...\n";

/** Default per-check deadline. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Resolve the canonical real path of `targetPath`, falling back to resolving
 * the closest existing ancestor when the leaf does not exist yet.
 */
async function resolveRealPath(targetPath: string): Promise<string> {
	const resolved = path.resolve(targetPath);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		const parent = path.dirname(resolved);
		if (parent === resolved) return resolved;
		const realParent = await resolveRealPath(parent);
		return path.join(realParent, path.basename(resolved));
	}
}

/**
 * Resolve `check.cwd` and ensure it does not escape `root`, including through
 * symlinks inside the verification root.
 */
export async function resolveCheckCwd(root: string, checkCwd: string | undefined): Promise<string> {
	const realRoot = await resolveRealPath(root);
	if (checkCwd === undefined) return realRoot;
	const candidate = path.resolve(realRoot, checkCwd);
	const realCwd = await resolveRealPath(candidate);
	const rel = path.relative(realRoot, realCwd);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Verification check cwd escapes root: ${checkCwd}`);
	}
	return realCwd;
}

/** Keep the tail of combined output so error summaries at the end survive. */
function truncateOutput(combined: string): string {
	if (combined.length <= OUTPUT_LIMIT) return combined;
	return `${TRUNCATED_PREFIX}${combined.slice(-OUTPUT_LIMIT)}`;
}

/** Run one shell command, capturing combined output under a deadline. */
async function runCheck(root: string, check: VerificationCheck, signal?: AbortSignal): Promise<CheckResult> {
	const startedAt = Date.now();
	if (signal?.aborted) {
		return {
			id: check.id,
			command: check.command,
			ok: false,
			exitCode: null,
			output: "",
			durationMs: 0,
			failure: "aborted",
		};
	}

	let cwd: string;
	try {
		cwd = await resolveCheckCwd(root, check.cwd);
	} catch (error) {
		return {
			id: check.id,
			command: check.command,
			ok: false,
			exitCode: null,
			output: "",
			durationMs: Date.now() - startedAt,
			failure: error instanceof Error ? error.message : String(error),
		};
	}

	if (signal?.aborted) {
		return {
			id: check.id,
			command: check.command,
			ok: false,
			exitCode: null,
			output: "",
			durationMs: Date.now() - startedAt,
			failure: "aborted",
		};
	}

	const timeoutMs = (check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
	const isWindows = process.platform === "win32";
	const cmd = isWindows ? ["cmd", "/c", check.command] : ["sh", "-c", check.command];

	let child: ptree.ChildProcess<"ignore">;
	try {
		// Use ptree's default buffered stderr (32KB tail cap) instead of `stderr: "full"`
		// so noisy checks cannot accumulate unbounded stderr chunks in memory.
		child = ptree.spawn(cmd, {
			cwd,
			env: { ...process.env, ...check.env },
			stdin: "ignore",
			detached: true,
			subreaper: true,
			timeout: timeoutMs,
			signal,
		});
	} catch (error) {
		return {
			id: check.id,
			command: check.command,
			ok: false,
			exitCode: null,
			output: "",
			durationMs: Date.now() - startedAt,
			failure: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		const result = await child.wait({ allowNonZero: true, allowAbort: true, stderr: "buffer" });
		const combined = truncateOutput(`${result.stdout}${result.stderr}`);
		if (result.exitError instanceof ptree.TimeoutError) {
			return {
				id: check.id,
				command: check.command,
				ok: false,
				exitCode: null,
				output: combined,
				durationMs: Date.now() - startedAt,
				failure: `timed out after ${timeoutMs / 1000}s`,
			};
		}
		if (result.exitError?.aborted || signal?.aborted) {
			return {
				id: check.id,
				command: check.command,
				ok: false,
				exitCode: null,
				output: combined,
				durationMs: Date.now() - startedAt,
				failure: signal?.aborted ? "aborted" : (result.exitError?.message ?? "aborted"),
			};
		}
		return {
			id: check.id,
			command: check.command,
			ok: result.exitCode === 0,
			exitCode: result.exitCode,
			output: combined,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		return {
			id: check.id,
			command: check.command,
			ok: false,
			exitCode: null,
			output: "",
			durationMs: Date.now() - startedAt,
			failure: signal?.aborted ? "aborted" : error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Sequential shell verifier.
 *
 * Checks run one at a time and stop at the first failure: a failing build makes
 * the later lint and test output noise, and stopping early keeps a broken
 * worker from burning the whole budget on checks that cannot pass.
 */
export class ShellVerifier implements Verifier {
	async verify(root: string, checks: readonly VerificationCheck[], signal?: AbortSignal): Promise<VerificationResult> {
		const results: CheckResult[] = [];
		for (const check of checks) {
			if (signal?.aborted) {
				results.push({
					id: check.id,
					command: check.command,
					ok: false,
					exitCode: null,
					output: "",
					durationMs: 0,
					failure: "aborted",
				});
				return { ok: false, checks: results, firstFailure: check.id };
			}
			const result = await runCheck(root, check, signal);
			results.push(result);
			if (!result.ok) {
				return { ok: false, checks: results, firstFailure: result.id };
			}
		}
		return { ok: true, checks: results };
	}
}

/** Verifier that accepts everything; the default when no checks are configured. */
export class NoopVerifier implements Verifier {
	async verify(
		_root: string,
		_checks: readonly VerificationCheck[],
		_signal?: AbortSignal,
	): Promise<VerificationResult> {
		return { ok: true, checks: [] };
	}
}

/**
 * Run `checks` against `branchName` in an isolated temporary detached worktree.
 *
 * Used when a worker's isolated worktree was already cleaned up or when a
 * branch must be verified without disturbing the primary checkout. The
 * temporary worktree is always removed before returning.
 */
export async function verifyBranchInTempWorktree(
	repoRoot: string,
	branchName: string,
	checks: readonly VerificationCheck[],
	verifier: Verifier,
	signal?: AbortSignal,
): Promise<VerificationResult> {
	const repo = vcs.git(repoRoot);
	if (!repo) {
		throw new Error(`Not a git repository: ${repoRoot}`);
	}

	const worktreesBase = getWorktreesDir();
	await fs.mkdir(worktreesBase, { recursive: true });
	const tempDir = await fs.mkdtemp(path.join(worktreesBase, "verify-"));
	try {
		await repo.worktreeAdd(tempDir, branchName, { detach: true, clone: false }, signal);
		return await verifier.verify(tempDir, checks, signal);
	} finally {
		try {
			const removed = await repo.worktreeRemove(tempDir, true);
			if (!removed) {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		} catch {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
		await repo.worktreePrune().catch(() => undefined);
	}
}

/** One-line summary for a report or a status message. */
export function describeVerification(result: VerificationResult): string {
	if (result.ok) return "verification passed";
	const failed = result.checks.find(check => !check.ok);
	if (!failed) return "verification failed";
	const detail = failed.failure ?? `exit ${failed.exitCode ?? "?"}`;
	return `verification failed at ${failed.id} (${detail})`;
}
