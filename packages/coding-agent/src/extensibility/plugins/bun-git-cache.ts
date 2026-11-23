import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@marsai-org/natives/vcs";
import { isEnoent } from "@marsai-org/utils";
import type { GitSource } from "./git-url";

const LOCAL_COMMAND_TIMEOUT_MS = 10_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runCommand(
	command: string[],
	cwd: string,
	timeoutMs = LOCAL_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
	const proc = Bun.spawn(command, {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<CommandResult>();
	const timer = setTimeout(() => {
		try {
			proc.kill?.();
		} catch {
			// Process may have already exited.
		}
		resolveTimeout({
			exitCode: 124,
			stdout: "",
			stderr: `${command[0] ?? "command"} timed out after ${timeoutMs}ms`,
		});
	}, timeoutMs);
	try {
		const completion = Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]).then(([exitCode, stdout, stderr]): CommandResult => ({ exitCode, stdout, stderr }));
		return await Promise.race([completion, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

function normalizeRepositoryUrl(repository: string): string {
	const withoutFragment = repository.replace(/^git\+/i, "").replace(/#.*$/, "");
	const scpLike = withoutFragment.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
	if (scpLike && !withoutFragment.includes("://")) {
		const host = scpLike[1]?.toLowerCase() ?? "";
		const repoPath = (scpLike[2] ?? "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return `ssh://${host}/${repoPath}`;
	}

	try {
		const parsed = new URL(withoutFragment);
		const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}/${repoPath}`;
	} catch {
		return withoutFragment.replace(/\/+$/g, "").replace(/\.git$/i, "");
	}
}

/** Fetches current heads and tags into Bun's matching cached bare clone before a plugin update. */
export async function refreshBunGitCache(source: GitSource, cwd: string): Promise<void> {
	const cacheResult = await runCommand(["bun", "pm", "cache"], cwd);
	if (cacheResult.exitCode !== 0) {
		throw new Error(`bun pm cache failed: ${cacheResult.stderr}`);
	}
	const cacheDir = cacheResult.stdout.trim();
	if (!cacheDir) {
		throw new Error("bun pm cache returned an empty cache path");
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(cacheDir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}

	const repositoryUrl = normalizeRepositoryUrl(source.repo);
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
		const repositoryDir = path.join(cacheDir, entry.name);
		let originUrl: string | undefined;
		try {
			originUrl = (await vcs.git(repositoryDir)?.remoteUrl("origin"))?.trim() || undefined;
		} catch {
			// Bare cache directories may not be opened by repo discovery; fall back to bounded git config.
		}
		if (!originUrl) {
			const originResult = await runCommand(
				["git", "-C", repositoryDir, "config", "--get", "remote.origin.url"],
				cwd,
				LOCAL_COMMAND_TIMEOUT_MS,
			);
			if (originResult.exitCode !== 0) continue;
			originUrl = originResult.stdout.trim();
		}
		if (!originUrl || normalizeRepositoryUrl(originUrl) !== repositoryUrl) continue;

		// `VcsGitRepo.fetch` takes a single refspec without `--prune`; keep a bounded non-interactive
		// git fetch here so Bun's bare cache updates both heads and tags atomically.
		const fetchResult = await runCommand(
			[
				"git",
				"-C",
				repositoryDir,
				"fetch",
				"--force",
				"--prune",
				"origin",
				"+refs/heads/*:refs/heads/*",
				"+refs/tags/*:refs/tags/*",
			],
			cwd,
			GIT_FETCH_TIMEOUT_MS,
		);
		if (fetchResult.exitCode !== 0) {
			throw new Error(`Failed to refresh Bun's git cache for ${source.host}/${source.path}: ${fetchResult.stderr}`);
		}
	}
}
