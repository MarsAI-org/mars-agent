/**
 * Offline platform self-check.
 *
 * A small, fast command that reports what a phone tester (or CI) needs first:
 * platform detection, glibc loader/runtime status, Mars config and data paths,
 * and worker availability. Emits human-readable text or JSON (`--json`). It is a
 * report, not a gate: it always exits 0 (a broken installation surfaces as
 * `not found` / `YES` lines and a non-zero exit is left to callers).
 *
 * Design reference: ORCHESTRATOR_DESIGN.md section 15 (Android/Termux support).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, VERSION, getAgentDir, getBaseConfigRoot } from "@marsai-org/utils/dirs";
import { getPlatformSummary, type PlatformEnvironment } from "@marsai-org/utils/platform";

export interface PlatformCheckReport {
	readonly command: "platform-check";
	readonly version: string;
	readonly appName: string;
	readonly platform: {
		readonly reportedPlatform: string;
		readonly arch: string;
		readonly isAndroid: boolean;
		readonly isTermux: boolean;
		readonly termuxPrefix?: string;
		readonly bunVersion: string;
	};
	readonly runtime: {
		readonly hasGlibcRunner: boolean;
		readonly glibcRunnerPath?: string;
		readonly glibcLoaderPath?: string;
		readonly injectedLdPreload: boolean;
	};
	readonly paths: {
		readonly configRoot: string;
		readonly agentDir: string;
		readonly home: string;
		readonly tmpdir: string;
		readonly onSharedStorage: boolean;
	};
	readonly workerHost: {
		readonly canSpawnWorkers: boolean;
		readonly workerHostEntry: string | undefined;
	};
}

function resolveGlibcPaths(env: Record<string, string | undefined>): { runner?: string; loader?: string } {
	const prefix = env.PREFIX ?? "";
	const runnerCandidates = ["grun", path.join(prefix, "glibc/bin/grun"), path.join(prefix, "glibc/bin/grun-termux")];
	for (const candidate of runnerCandidates) {
		const resolved = candidate === "grun" ? Bun.which(candidate) : fs.existsSync(candidate) ? candidate : undefined;
		if (resolved) return { runner: resolved };
	}
	const loaderCandidate = path.join(prefix, "glibc/lib/ld-linux-aarch64.so.1");
	if (fs.existsSync(loaderCandidate)) return { loader: loaderCandidate };
	return {};
}

/** Whether a path lives on Android shared storage, where Mars must not install. */
export function isOnSharedStorage(absolutePath: string): boolean {
	// Android shared storage roots; Mars must never place binaries or config here.
	// Compare on path boundaries so `/sdcard2` is not mistaken for `/sdcard`.
	const sharedRoots = ["/sdcard", "/storage/emulated", "/mnt/sdcard"];
	const normalized = absolutePath.replace(/\/+$/, "");
	return sharedRoots.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

/** Build the report; pure reads only, so it is safe to call anywhere. */
export function buildPlatformCheckReport(context: PlatformEnvironment = {}): PlatformCheckReport {
	const env = context.env ?? process.env;
	const summary = getPlatformSummary(context);
	const glibc = resolveGlibcPaths(env);
	const configRoot = getBaseConfigRoot();
	const ldPreload = env.LD_PRELOAD ?? "";
	return {
		command: "platform-check",
		version: VERSION,
		appName: APP_NAME,
		platform: {
			reportedPlatform: context.platform ?? process.platform,
			arch: context.arch ?? process.arch,
			isAndroid: summary.isAndroid,
			isTermux: summary.isTermux,
			termuxPrefix: summary.termuxPrefix,
			bunVersion: Bun.version,
		},
		runtime: {
			hasGlibcRunner: Boolean(glibc.runner ?? glibc.loader),
			glibcRunnerPath: glibc.runner,
			glibcLoaderPath: glibc.loader,
			injectedLdPreload: ldPreload.includes("libtermux-exec"),
		},
		paths: {
			configRoot,
			agentDir: getAgentDir(),
			home: os.homedir(),
			tmpdir: os.tmpdir(),
			onSharedStorage: isOnSharedStorage(configRoot) || isOnSharedStorage(os.homedir()),
		},
		workerHost: {
			// Termux note: Android 12+ can kill background children; the cap and
			// keep-alive strategy live in the orchestrator settings. This probes
			// whether this runtime can construct workers at all (the same check the
			// subagent machinery relies on).
			canSpawnWorkers: typeof globalThis.Worker === "function",
			workerHostEntry: process.execPath,
		},
	};
}

function formatReport(report: PlatformCheckReport): string {
	const lines: string[] = [];
	lines.push(`${report.appName} ${report.version} — platform check`);
	lines.push(
		`platform: ${report.platform.reportedPlatform}/${report.platform.arch} (bun ${report.platform.bunVersion})`,
	);
	lines.push(
		`android: ${report.platform.isAndroid ? "yes" : "no"} · termux: ${report.platform.isTermux ? "yes" : "no"}`,
	);
	if (report.platform.termuxPrefix) lines.push(`termux prefix: ${report.platform.termuxPrefix}`);
	lines.push(
		`glibc runner: ${report.runtime.hasGlibcRunner ? `${report.runtime.glibcRunnerPath ?? report.runtime.glibcLoaderPath}` : "not found"}`,
	);
	lines.push(
		`injected LD_PRELOAD: ${report.runtime.injectedLdPreload ? "yes (libtermux-exec; launcher clears it)" : "no"}`,
	);
	lines.push(`config root: ${report.paths.configRoot}`);
	lines.push(`agent dir: ${report.paths.agentDir}`);
	lines.push(`home: ${report.paths.home}`);
	lines.push(`tmpdir: ${report.paths.tmpdir}`);
	lines.push(
		`shared storage in use: ${report.paths.onSharedStorage ? "YES — move config under the Termux home" : "no"}`,
	);
	lines.push(`worker host: ${report.workerHost.canSpawnWorkers ? "available" : "unavailable"}`);
	if (report.platform.isTermux) {
		lines.push("tip: run `termux-wake-lock` before long multi-worker runs so Android does not");
		lines.push("     suspend the session; release it with `termux-wake-unlock` when finished.");
	}
	return lines.join("\n");
}

/** Entry point for `mars --platform-check` (and `--platform-check --json`). */
export async function runPlatformCheck(argv: readonly string[] = process.argv): Promise<void> {
	const report = buildPlatformCheckReport();
	if (argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${formatReport(report)}\n`);
}
