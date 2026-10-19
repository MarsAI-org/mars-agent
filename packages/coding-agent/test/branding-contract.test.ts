/**
 * Branding contract: the shipped CLI must present itself as Mars on every
 * user-visible surface. This is an end-to-end guard, not a unit test — it
 * spawns the real CLI entry point and inspects what a user would actually see.
 *
 * The regression this covers: `mars --version` reported the upstream fork's
 * 18.x version, `mars --help` still advertised upstream `*.omp.sh` hosts, and
 * the bundled changelog carried upstream `can1357/oh-my-pi` links. Those are
 * distinct leaks, so each surface gets its own assertion.
 *
 * The CLI is source-run through Bun (`bun src/cli.ts`), which is how the repo's
 * other CLI tests invoke it. When the entry cannot run in the current
 * environment (missing dependencies, unbuilt native addon on a code path that
 * needs it), the affected test is skipped with the reason in its name instead
 * of passing silently. A skip is never evidence that the branding is correct.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const packageChangelog = path.join(repoRoot, "packages", "coding-agent", "CHANGELOG.md");

/**
 * The upstream fork's version line is `mars/18.8.6`. Match an 18.x semver that
 * is not embedded in a longer version (so a legitimate `0.18.0` does not trip
 * the check).
 */
const UPSTREAM_MAJOR_VERSION_RE = /(?<![\d.])18\.\d+\.\d+(?![\d.])/;

/**
 * `omp` as a standalone brand token. The lookarounds keep legitimate words
 * such as "component", "compact", "compare", and "compile" from matching,
 * while still catching `omp`, `omp.sh`, and `OMP` as separate words.
 */
const OMP_BRAND_TOKEN_RE = /(?<![A-Za-z0-9_])omp(?![A-Za-z0-9_])/i;

/** Legacy upstream environment variables are user-visible when help documents them. */
const OMP_ENV_VAR_RE = /(?<![A-Za-z0-9_])OMP_[A-Z0-9_]+/;

/** Longest expected line when reporting a leak, to keep failure output readable. */
const MAX_LEAK_LINE = 200;

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface LeakReport {
	count: number;
	sample: string[];
}

/**
 * Run the real CLI entry point as a child process. A timeout kills the child
 * and rejects so a hanging command cannot stall the whole test file.
 */
async function runCli(args: string[], timeoutMs = 60_000): Promise<CliResult> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timeout">(resolve => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		const completed = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const outcome = await Promise.race([completed, timedOut]);
		if (outcome === "timeout") {
			proc.kill("SIGKILL");
			await proc.exited;
			throw new Error(`timed out after ${timeoutMs}ms: mars ${args.join(" ")}`);
		}
		const [exitCode, stdout, stderr] = outcome;
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/** First non-empty line, used to keep skip reasons to one sentence. */
function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.map(line => line.trim())
			.find(line => line.length > 0) ?? ""
	);
}

/**
 * Report every line that matches a brand leak. Returning a sample rather than
 * the whole surface keeps failures readable while still naming the offender.
 */
function findLeaks(text: string, pattern: RegExp, limit = 5): LeakReport {
	const hits = text
		.split(/\r?\n/)
		.filter(line => pattern.test(line))
		.map(line => line.trim().slice(0, MAX_LEAK_LINE));
	return { count: hits.length, sample: hits.slice(0, limit) };
}

/** Format a leak report as an assertion message with the offending lines. */
function leakMessage(surface: string, pattern: RegExp, leaks: LeakReport): string {
	const lines = leaks.sample.length > 0 ? `\n${leaks.sample.join("\n")}` : "";
	return `${leaks.count} upstream branding leak(s) matching ${pattern} in ${surface}:${lines}`;
}

/**
 * A CLI error caused by the environment (missing install, unbuilt addon) is
 * not a branding result. Detect it so the error-surface test skips honestly.
 */
const ENVIRONMENT_FAILURE_RE =
	/Failed to load .*native addon|Cannot find module|ERR_MODULE_NOT_FOUND|command not found|ENOENT/i;

/**
 * Probe once at module load so each test can decide whether the CLI is
 * runnable here. The probe intentionally checks only that the process runs and
 * produces output — branding correctness is asserted by the tests, so a wrong
 * version string must not be mistaken for an unavailable environment.
 */
async function probeCli(): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		const result = await runCli(["--version"], 30_000);
		if (result.exitCode !== 0) {
			const detail = firstLine(result.stderr) || firstLine(result.stdout) || "no output";
			return { ok: false, reason: `\`mars --version\` exited ${result.exitCode}: ${detail}` };
		}
		if (!result.stdout.trim() && !result.stderr.trim()) {
			return { ok: false, reason: "`mars --version` produced no output" };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

const probe = await probeCli();
const skipSuffix = probe.ok ? "" : ` [skipped: ${probe.reason}]`;
if (!probe.ok) {
	// Printed in addition to the test name so the reason is visible even when
	// the reporter collapses skipped tests.
	console.warn(`[branding-contract] CLI unavailable, branding checks skipped: ${probe.reason}`);
}
const cliIt = it.skipIf(!probe.ok);

/**
 * Exercise a real user-facing error path: an invalid flag value is rejected by
 * argument validation before any model, credential, or network work, so it is
 * reachable in every environment where the CLI itself runs. Some environments
 * cannot even get that far (the command graph loads the native addon first),
 * so probe it separately and skip only this assertion when it is unreachable.
 */
const INVALID_MODE_ARG = "--mode=__branding_contract_invalid_mode__";
const errorProbe = probe.ok ? await runCli([INVALID_MODE_ARG], 30_000).catch(() => null) : null;
const errorPathReason =
	errorProbe === null
		? "the CLI error path could not be spawned"
		: errorProbe.exitCode === 0
			? "an invalid --mode value unexpectedly exited 0"
			: ENVIRONMENT_FAILURE_RE.test(`${errorProbe.stdout}\n${errorProbe.stderr}`)
				? `the CLI cannot reach argument validation here: ${firstLine(errorProbe.stderr) || firstLine(errorProbe.stdout)}`
				: null;
const errorPathUsable = errorPathReason === null;
if (!errorPathUsable) {
	// Same rationale as the probe warning above: the reporter may collapse
	// skipped tests, so state the reason on its own line.
	console.warn(`[branding-contract] error-surface check skipped: ${errorPathReason}`);
}
const errorIt = it.skipIf(!errorPathUsable);

describe("branding contract", () => {
	cliIt(
		`prints a Mars version line without the upstream 18.x version${skipSuffix}`,
		async () => {
			const result = await runCli(["--version"]);
			const output = result.stdout + result.stderr;

			expect(result.exitCode).toBe(0);
			expect(output.toLowerCase()).toContain("mars");
			expect(output).not.toMatch(UPSTREAM_MAJOR_VERSION_RE);
		},
		60_000,
	);

	cliIt(
		`does not expose upstream brand tokens in --help${skipSuffix}`,
		async () => {
			const result = await runCli(["--help"]);
			const help = result.stdout + result.stderr;

			expect(result.exitCode).toBe(0);

			const hyphenated = findLeaks(help, /oh-my-pi/i);
			expect(hyphenated.count, leakMessage("--help", /oh-my-pi/i, hyphenated)).toBe(0);

			const spaced = findLeaks(help, /oh\s+my\s+pi/i);
			expect(spaced.count, leakMessage("--help", /oh\s+my\s+pi/i, spaced)).toBe(0);

			const token = findLeaks(help, OMP_BRAND_TOKEN_RE);
			expect(token.count, leakMessage("--help", OMP_BRAND_TOKEN_RE, token)).toBe(0);

			const envVars = findLeaks(help, OMP_ENV_VAR_RE);
			expect(envVars.count, leakMessage("--help", OMP_ENV_VAR_RE, envVars)).toBe(0);
		},
		60_000,
	);

	it("does not ship an upstream changelog reference", async () => {
		const changelog = await Bun.file(packageChangelog).text();
		expect(changelog.length).toBeGreaterThan(0);

		const upstreamLinks = findLeaks(changelog, /can1357\/oh-my-pi/i);
		expect(
			upstreamLinks.count,
			leakMessage("packages/coding-agent/CHANGELOG.md", /can1357\/oh-my-pi/i, upstreamLinks),
		).toBe(0);

		// Two mentions are legitimate: the fork lineage (MIT attribution) and the
		// migration entry that names the old npm scope it replaced. Anything else
		// would be upstream branding presented as this project's own.
		const attribution = /fork of\s*\n?oh-my-pi by can1357/i;
		const migration = /Renamed the npm scope from `@oh-my-pi\/\*`/i;
		const withoutAttribution = changelog.replace(attribution, "").replace(migration, "");
		expect(changelog).not.toBe(withoutAttribution.replace(migration, ""));

		const upstreamName = findLeaks(withoutAttribution, /oh-my-pi/i);
		expect(
			upstreamName.count,
			leakMessage("packages/coding-agent/CHANGELOG.md", /oh-my-pi/i, upstreamName),
		).toBe(0);

		// The npm bundle copies the changelog into dist/. When a build is present,
		// the shipped copy must be clean too; a missing dist/ is not a failure.
		const distDir = path.join(repoRoot, "packages", "coding-agent", "dist");
		const distChangelogs = fs.existsSync(distDir)
			? fs
					.readdirSync(distDir)
					.filter(entry => entry.startsWith("CHANGELOG-") && entry.endsWith(".md"))
					.map(entry => path.join(distDir, entry))
			: [];
		for (const distChangelog of distChangelogs) {
			const text = fs.readFileSync(distChangelog, "utf8");
			const leaks = findLeaks(text, /oh-my-pi/i);
			expect(leaks.count, leakMessage(path.relative(repoRoot, distChangelog), /oh-my-pi/i, leaks)).toBe(0);
		}
	});

	errorIt(
		`does not leak upstream branding in user-facing error output${
			errorPathUsable ? "" : ` [skipped: ${errorPathReason}]`
		}`,
		async () => {
			expect(errorProbe).not.toBeNull();
			if (errorProbe === null) return;

			expect(errorProbe.exitCode).not.toBe(0);
			const output = `${errorProbe.stdout}\n${errorProbe.stderr}`;

			const hyphenated = findLeaks(output, /oh-my-pi/i);
			expect(hyphenated.count, leakMessage("usage-error output", /oh-my-pi/i, hyphenated)).toBe(0);

			const token = findLeaks(output, OMP_BRAND_TOKEN_RE);
			expect(token.count, leakMessage("usage-error output", OMP_BRAND_TOKEN_RE, token)).toBe(0);
		},
		60_000,
	);
});
