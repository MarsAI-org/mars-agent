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

import { spawn } from "node:child_process";

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
	verify(root: string, checks: readonly VerificationCheck[]): Promise<VerificationResult>;
}

/** Output kept per check; enough to diagnose without flooding the transcript. */
const OUTPUT_LIMIT = 8_000;

/** Default per-check deadline. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Run one shell command, capturing combined output under a deadline. */
function runCheck(root: string, check: VerificationCheck): Promise<CheckResult> {
	const startedAt = Date.now();
	const cwd = check.cwd === undefined ? root : `${root}/${check.cwd}`;
	const timeoutMs = (check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
	const isWindows = process.platform === "win32";

	return new Promise<CheckResult>(resolve => {
		let settled = false;
		const finish = (result: CheckResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(isWindows ? "cmd" : "sh", isWindows ? ["/c", check.command] : ["-c", check.command], {
				cwd,
				env: { ...process.env, ...check.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				id: check.id,
				command: check.command,
				ok: false,
				exitCode: null,
				output: "",
				durationMs: Date.now() - startedAt,
				failure: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		let output = "";
		const append = (chunk: Buffer): void => {
			if (output.length >= OUTPUT_LIMIT) return;
			output += chunk.toString("utf8").slice(0, OUTPUT_LIMIT - output.length);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				id: check.id,
				command: check.command,
				ok: false,
				exitCode: null,
				output,
				durationMs: Date.now() - startedAt,
				failure: `timed out after ${timeoutMs / 1000}s`,
			});
		}, timeoutMs);

		child.on("error", error => {
			finish({
				id: check.id,
				command: check.command,
				ok: false,
				exitCode: null,
				output,
				durationMs: Date.now() - startedAt,
				failure: error.message,
			});
		});
		child.on("close", code => {
			finish({
				id: check.id,
				command: check.command,
				ok: code === 0,
				exitCode: code,
				output,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

/**
 * Sequential shell verifier.
 *
 * Checks run one at a time and stop at the first failure: a failing build makes
 * the later lint and test output noise, and stopping early keeps a broken
 * worker from burning the whole budget on checks that cannot pass.
 */
export class ShellVerifier implements Verifier {
	async verify(root: string, checks: readonly VerificationCheck[]): Promise<VerificationResult> {
		const results: CheckResult[] = [];
		for (const check of checks) {
			const result = await runCheck(root, check);
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
	async verify(_root: string, _checks: readonly VerificationCheck[]): Promise<VerificationResult> {
		return { ok: true, checks: [] };
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
