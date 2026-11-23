import { afterEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pluginCli from "@marsai-org/coding-agent/cli/plugin-cli";
import * as updateCli from "@marsai-org/coding-agent/cli/update-cli";
import {
	buildMiseForceInstallArgs,
	buildMiseUpdateEnv,
	buildMiseUpgradeArgs,
	downloadVerifiedBinary,
	homebrewUpdateRefusal,
	type InstalledVersionVerification,
	isMuslLinuxForTest,
	parseReportedVersion,
	parseUpdateArgs,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveGitHubTokenForTest,
	resolveReleaseBinaryAsset,
	resolveUpdateMethodForTest,
	resolveUpdateTargetFromPath,
	selectFallbackBinaryAsset,
	sweepStaleUpdateArtifacts,
	updateViaBinaryAt,
	updateViaShimTakeover,
} from "@marsai-org/coding-agent/cli/update-cli";
import Update from "@marsai-org/coding-agent/commands/update";
import { $which, removeWithRetries } from "@marsai-org/utils";
import type { CliConfig } from "@marsai-org/utils/cli";
import { getThemeByName, setThemeInstance } from "@marsai-org/tui/theme";

const miseBinary = Bun.env.MISE_BIN ?? $which("mise");

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mars-update-test-")));
	tempDirs.push(dir);
	return dir;
}
/**
 * Run `fn` with `process.platform` reporting `platform`. Launcher
 * classification and recovery hints are platform-gated, so the gate itself has
 * to be driven from whichever host runs this suite.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platformDescriptor) throw new Error("process.platform descriptor missing");
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

/** npm's global layout: `<prefix>/bin` + `<prefix>/lib/node_modules` on POSIX; both rooted at `<prefix>` on Windows. */
function npmGlobalLayout(prefix: string): { binDir: string; nodeModulesDir: string } {
	return process.platform === "win32"
		? { binDir: prefix, nodeModulesDir: path.join(prefix, "node_modules") }
		: { binDir: path.join(prefix, "bin"), nodeModulesDir: path.join(prefix, "lib", "node_modules") };
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "mars",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true, channel: undefined });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({
			force: false,
			check: false,
			plugins: true,
			channel: undefined,
		});
	});

	it("parses update channels", () => {
		expect(parseUpdateArgs(["update", "--canary"])?.channel).toBe("canary");
		expect(parseUpdateArgs(["update", "--stable"])?.channel).toBe("stable");
		expect(parseUpdateArgs(["update"])?.channel).toBeUndefined();
	});

	it("rejects conflicting update channels", () => {
		expect(() => parseUpdateArgs(["update", "--canary", "--stable"])).toThrow(
			"--canary and --stable are mutually exclusive",
		);
	});
});
describe("GitHub update credentials", () => {
	it("prefers an explicit environment token over gh auth", async () => {
		let calls = 0;
		const token = await resolveGitHubTokenForTest({
			envToken: "env-token",
			ghPath: "gh",
			runGhAuthToken: async () => {
				calls += 1;
				return "keyring-token";
			},
		});
		expect(token).toBe("env-token");
		expect(calls).toBe(0);
	});

	it("uses gh auth when no environment token is configured", async () => {
		const token = await resolveGitHubTokenForTest({
			envToken: "",
			ghPath: "gh",
			runGhAuthToken: async path => path + "-token  ",
		});
		expect(token).toBe("gh-token");
	});

	it("falls back to GH_TOKEN when GITHUB_TOKEN is empty", async () => {
		const previousGitHubToken = Bun.env.GITHUB_TOKEN;
		const previousGhToken = Bun.env.GH_TOKEN;
		Bun.env.GITHUB_TOKEN = "";
		Bun.env.GH_TOKEN = "gh-env-token";
		try {
			expect(await resolveGitHubTokenForTest({ ghPath: null })).toBe("gh-env-token");
		} finally {
			if (previousGitHubToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousGitHubToken;
			if (previousGhToken === undefined) delete Bun.env.GH_TOKEN;
			else Bun.env.GH_TOKEN = previousGhToken;
		}
	});

	it("keeps anonymous fallback when gh is unavailable", async () => {
		const token = await resolveGitHubTokenForTest({ envToken: "", ghPath: null });
		expect(token).toBeUndefined();
	});
});

describe("parseReportedVersion", () => {
	it("preserves the prerelease suffix so a canary launcher verifies as up to date", () => {
		// Regression: dropping `-canary.1` made a correctly installed canary
		// build look like a stale `X.Y.Z` launcher, triggering a binary repair
		// that rejects the prerelease GitHub release.
		expect(parseReportedVersion("mars/18.0.6-canary.1")).toBe("18.0.6-canary.1");
		expect(parseReportedVersion("mars/18.0.5")).toBe("18.0.5");
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/18.0.5")).toBeUndefined();
		expect(parseReportedVersion("codex/18.0.5")).toBeUndefined();
	});
});

describe("update-cli libc detection", () => {
	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("update-cli install target detection", () => {
	it("leaves Nix store installations under Nix management", () => {
		const method = resolveUpdateMethodForTest(
			"/nix/store/0123456789-mars-17.2.15/bin/mars",
			"/nix/store/9876543210-bun-1.3.14/bin",
		);

		expect(method).toBe("nix");
	});

	it("uses shim takeover for Windows script launchers", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\omp.cmd", undefined);

		expect(method).toBe("shim");
	});

	it("uses binary update for plain files in bun or npm global bin dirs", () => {
		const npmMethod = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/mars", undefined, {
				npmBinDir: "/home/u/.local/bin",
				ompIsRegularFile: true,
			}),
		);
		const bunMethod = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/mars", "/home/u/.local/bin", {
				ompIsRegularFile: true,
			}),
		);

		expect(npmMethod).toBe("binary");
		expect(bunMethod).toBe("binary");
	});

	it("uses binary update for Windows .exe binaries in bun global bin dir", () => {
		const method = withPlatform("win32", () =>
			resolveUpdateMethodForTest("C:/Users/test/.bun/bin/mars.exe", "C:/Users/test/.bun/bin", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("updates the standalone binary behind a foreign npm-bin alias without replacing the alias", async () => {
		const dir = await makeTempDir();
		const npmBinDir = path.join(dir, ".npm-global", "bin");
		const standalonePath = path.join(dir, ".local", "bin", "mars");
		const aliasPath = path.join(npmBinDir, "mars");
		await fs.mkdir(npmBinDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(aliasPath)).toBe(standalonePath);
	});

	it("treats a Bun-bin alias into ~/.bun/custom as foreign", async () => {
		const dir = await makeTempDir();
		const bunDir = path.join(dir, ".bun");
		const bunBinDir = path.join(bunDir, "bin");
		const standalonePath = path.join(bunDir, "custom", "mars");
		const aliasPath = path.join(bunBinDir, "mars");
		await fs.mkdir(bunBinDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(path.relative(bunBinDir, standalonePath), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, bunBinDir);

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
	});

	it("resolves a foreign symlink to its real binary instead of clobbering the launcher", async () => {
		const dir = await makeTempDir();
		const sharedBinDir = path.join(dir, "opt", "mars", "bin");
		const standalonePath = path.join(sharedBinDir, "mars");
		const launcherDir = path.join(dir, "usr", "local", "bin");
		const launcherPath = path.join(launcherDir, "mars");
		await fs.mkdir(sharedBinDir, { recursive: true });
		await fs.mkdir(launcherDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, launcherPath);

		const target = resolveUpdateTargetFromPath(launcherPath, undefined);

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(launcherPath)).toBe(standalonePath);
	});

	it.skipIf(process.platform === "win32")(
		"refuses to overwrite a shared shebang dispatcher behind a foreign symlink",
		async () => {
			const dir = await makeTempDir();
			const dispatcherPath = path.join(dir, "launch");
			const aliasPath = path.join(dir, "mars");
			const dispatcher = "#!/bin/sh\necho dispatcher\n";
			await Bun.write(dispatcherPath, dispatcher);
			await fs.chmod(dispatcherPath, 0o755);
			await fs.symlink("launch", aliasPath);
			const fetchImpl = vi.fn(async () => new Response());

			const target = resolveUpdateTargetFromPath(aliasPath, undefined);
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, "18.1.13", {
					binaryName: "mars-linux-x64",
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow(`Refusing to replace ${dispatcherPath}`);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(await Bun.file(dispatcherPath).text()).toBe(dispatcher);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a foreign native target that does not report a Mars version",
		async () => {
			const dir = await makeTempDir();
			const foreignPath = path.join(dir, "foreign");
			const aliasPath = path.join(dir, "mars");
			await fs.copyFile(process.execPath, foreignPath);
			await fs.chmod(foreignPath, 0o755);
			await fs.symlink(foreignPath, aliasPath);
			const fetchImpl = vi.fn(async () => new Response());
			const target = resolveUpdateTargetFromPath(aliasPath, undefined);
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, "18.1.13", {
					binaryName: "mars-linux-x64",
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow("does not report a Mars version when run directly");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("takes over a legacy npm package-manager launcher in place", async () => {
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const { binDir: npmBinDir, nodeModulesDir } = npmGlobalLayout(npmPrefix);
		const managedBinary = path.join(nodeModulesDir, "@marsai-org", "coding-agent", "mars");
		const aliasPath = path.join(npmBinDir, "mars");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(managedBinary), { recursive: true });
		await Bun.write(managedBinary, "binary");
		await fs.symlink(managedBinary, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: aliasPath,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
	});

	it("takes over a split-root legacy Bun launcher in place without touching its linked checkout", async () => {
		const dir = await makeTempDir();
		const bunBinDir = path.join(dir, "bun-bin");
		const bunGlobalDir = path.join(dir, "bun-global");
		const packagePath = path.join(bunGlobalDir, "node_modules", "@marsai-org", "coding-agent");
		const checkoutPath = path.join(dir, "checkout");
		const checkoutCli = path.join(checkoutPath, "dist", "cli.js");
		const aliasPath = path.join(bunBinDir, "mars");
		await fs.mkdir(bunBinDir, { recursive: true });
		await fs.mkdir(path.dirname(packagePath), { recursive: true });
		await Bun.write(checkoutCli, "linked checkout");
		await fs.symlink(checkoutPath, packagePath, "junction");
		await fs.symlink(path.relative(bunBinDir, path.join(packagePath, "dist", "cli.js")), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, bunBinDir, {
			bunGlobalDir,
		});

		expect(await fs.realpath(aliasPath)).toBe(checkoutCli);
		expect(target).toEqual({
			method: "binary",
			path: aliasPath,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
		expect(await Bun.file(checkoutCli).text()).toBe("linked checkout");
	});

	it("uses binary update when prioritized mars is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/mars", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/mars", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized mars resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "mars");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "mars"), "binary");
		await fs.symlink(path.join(prefix, "bin", "mars"), path.join(linkedBin, "mars"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "mars"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized mars is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/mars",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized mars is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/mars", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("refuses Homebrew self-update and names the official installer", () => {
		const message = homebrewUpdateRefusal();

		expect(message).toContain("not distributed through Homebrew");
		expect(message).toContain("https://getmars.eu.cc/install");
		expect(message).not.toContain("bun install -g");
		// Regression: the updater must never reference the upstream tap, which
		// would install oh-my-pi over Mars.
		expect(message).not.toContain("can1357");
		expect(message).not.toContain("omp");
	});

	it("targets the mise GitHub backend and overrides release-age settings for attended updates", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:MarsAI-org/mars-agent", "--bump", "--before", "0s"]);
		expect(buildMiseUpgradeArgs(false)).toEqual(["upgrade", "github:MarsAI-org/mars-agent", "--bump"]);
		expect(buildMiseUpdateEnv({ PATH: "/bin", MISE_MINIMUM_RELEASE_AGE: "24h" })).toEqual({
			PATH: "/bin",
			MISE_MINIMUM_RELEASE_AGE: "0s",
		});
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual([
			"install",
			"--force",
			"github:MarsAI-org/mars-agent@15.10.5",
		]);
	});

	it.skipIf(!miseBinary)("overrides per-tool release age during actual mise upgrade resolution", async () => {
		if (!miseBinary) throw new Error("mise binary unavailable");
		const root = await makeTempDir();
		const releases = [
			{ tag_name: "v2.0.0", draft: false, prerelease: false, created_at: "2026-09-09T00:00:00Z", assets: [] },
			{ tag_name: "v1.0.0", draft: false, prerelease: false, created_at: "2020-01-01T00:00:00Z", assets: [] },
		];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname.endsWith("/releases/latest")) return Response.json(releases[0]);
				if (pathname.endsWith("/releases")) return Response.json(releases);
				return new Response("not found", { status: 404 });
			},
		});
		try {
			await Bun.write(
				path.join(root, "mise.toml"),
				`[tools]
"github:MarsAI-org/mars-agent" = { version = "1", minimum_release_age = "999y", api_url = "${server.url}" }
`,
			);
			const env = {
				...process.env,
				HOME: path.join(root, "home"),
				MISE_CACHE_DIR: path.join(root, "cache"),
				MISE_CONFIG_DIR: path.join(root, "config"),
				MISE_DATA_DIR: path.join(root, "data"),
				MISE_STATE_DIR: path.join(root, "state"),
				HTTP_PROXY: "http://127.0.0.1:9",
				HTTPS_PROXY: "http://127.0.0.1:9",
				ALL_PROXY: "http://127.0.0.1:9",
				NO_PROXY: "127.0.0.1,localhost",
			};
			const run = async (args: string[]): Promise<string> => {
				const process = Bun.spawn([miseBinary, "-C", root, ...args], {
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(process.stdout).text(),
					new Response(process.stderr).text(),
					process.exited,
				]);
				if (exitCode !== 0) throw new Error(`mise upgrade failed: ${stdout}${stderr}`);
				return stdout + stderr;
			};

			const blocked = await run(["upgrade", "github:MarsAI-org/mars-agent", "--bump", "--dry-run"]);
			expect(blocked).not.toContain("Would install github:MarsAI-org/mars-agent@2.0.0");

			const allowed = await run([...buildMiseUpgradeArgs(), "--dry-run"]);
			expect(allowed).toContain("Would install github:MarsAI-org/mars-agent@2.0.0");
		} finally {
			server.stop(true);
		}
	});

	it("derives global node_modules from supported Bun locations with the explicit global directory taking precedence", () => {
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				globalBinDir: path.join("home", ".bun", "bin"),
			}),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				cacheDir: path.join("home", ".bun", "install", "cache"),
			}),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				globalDir: path.join("root", "bun-global"),
				globalBinDir: path.join("root", "bun-bin"),
			}),
		).toBe(path.join("root", "bun-global", "node_modules"));
	});
});

describe("update-cli release binary integrity", () => {
	const tag = "v17.1.2";
	const binaryName = "mars-linux-x64";
	const url = `https://github.com/MarsAI-org/mars-agent/releases/download/${tag}/${binaryName}`;
	const content = "verified binary";
	const digest = `sha256:${Bun.SHA256.hash(content, "hex")}`;

	function releaseAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			tag_name: tag,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					size: Buffer.byteLength(content),
					digest,
					browser_download_url: url,
					...overrides,
				},
			],
		};
	}

	it("selects an uploaded asset with a valid SHA-256 digest", () => {
		expect(resolveReleaseBinaryAsset(releaseAsset(), tag, binaryName)).toEqual({
			version: "17.1.2",
			url,
			size: Buffer.byteLength(content),
			digest,
		});
	});

	it("rejects missing and unsupported release asset digests", () => {
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: null }), tag, binaryName)).toThrow("has no digest");
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: "sha512:abc" }), tag, binaryName)).toThrow(
			"has an unsupported digest",
		);
	});

	it("rejects a draft, a stable-channel prerelease, and metadata without one exact asset", () => {
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), draft: true }, tag, binaryName)).toThrow(
			"is a draft",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName)).toThrow(
			"is a prerelease",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), assets: [] }, tag, binaryName)).toThrow(
			`has 0 assets named ${binaryName}`,
		);
		expect(() =>
			resolveReleaseBinaryAsset(
				{ ...releaseAsset(), assets: [releaseAsset().assets, releaseAsset().assets].flat() },
				tag,
				binaryName,
			),
		).toThrow(`has 2 assets named ${binaryName}`);
		expect(() =>
			resolveReleaseBinaryAsset(
				releaseAsset({ browser_download_url: "https://example.com/mars-linux-x64" }),
				tag,
				binaryName,
			),
		).toThrow("has an unexpected download URL");
	});

	it("installs a prerelease asset only when a canary update permits it", () => {
		// Canary GitHub releases are marked prerelease; a canary update passes
		// allowPrerelease so its exact-tag asset installs, while a draft stays
		// rejected even then.
		expect(
			resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName, { allowPrerelease: true }),
		).toEqual({ version: "17.1.2", url, size: Buffer.byteLength(content), digest });
		expect(() =>
			resolveReleaseBinaryAsset({ ...releaseAsset(), draft: true }, tag, binaryName, { allowPrerelease: true }),
		).toThrow("is a draft");
	});

	it("writes a download only after its size and digest match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);

		await downloadVerifiedBinary({
			url,
			targetPath,
			expectedSize: Buffer.byteLength(content),
			expectedDigest: digest,
			fetchImpl: async () => new Response(content),
		});

		expect(await Bun.file(targetPath).text()).toBe(content);
		// Windows has no POSIX mode bits; the executable bit is only observable elsewhere.
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
	});

	it("aborts the response stream as soon as it exceeds the expected size", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(pulls === 1 ? 2 : 1));
					if (pulls === 2) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: 1,
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("received at least 2");
		expect(pulls).toBe(1);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("wraps a timeout during body streaming with a friendly message", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1));
					controller.error(new DOMException("The operation timed out.", "TimeoutError"));
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("Timed out downloading release binary after 15 minutes");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("removes downloads whose size or digest does not match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(content);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content) + 1,
				expectedDigest: digest,
				fetchImpl,
			}),
		).rejects.toThrow("size mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: `sha256:${Bun.SHA256.hash("different binary", "hex")}`,
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("rejects an altered version-reporting executable before replacing the installed binary", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const installed = "#!/bin/sh\necho mars/17.0.8\n";
		const altered = "#!/bin/sh\necho mars/17.1.2\n";
		const expectedDigest = `sha256:${Bun.SHA256.hash("x".repeat(Buffer.byteLength(altered)), "hex")}`;
		await Bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);

		const metadataAuthorizations: Array<string | null> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) {
				metadataAuthorizations.push(new Headers(init?.headers).get("Authorization"));
				return new Response(
					JSON.stringify(
						releaseAsset({
							size: Buffer.byteLength(altered),
							digest: expectedDigest,
						}),
					),
				);
			}
			if (requestUrl === url) return new Response(altered);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const previousGitHubToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		try {
			await expect(
				updateViaBinaryAt(targetPath, "17.1.2", {
					binaryName,
					fetchImpl,
				}),
			).rejects.toThrow("digest mismatch");
			expect(metadataAuthorizations).toEqual(["Bearer test-token"]);
			expect(await Bun.file(targetPath).text()).toBe(installed);
			if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
			const newResidue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
			expect(newResidue).toEqual([]);
		} finally {
			if (previousGitHubToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousGitHubToken;
		}
	});

	it("explains how to authenticate after an anonymous GitHub API rate limit", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(null, { status: 403, statusText: "rate limit exceeded" });

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "",
			}),
		).rejects.toThrow("retry later or set GITHUB_TOKEN or GH_TOKEN");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	function publishedRelease(version: string, body: string, overrides: Record<string, unknown> = {}) {
		return {
			tag_name: `v${version}`,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					size: Buffer.byteLength(body),
					digest: `sha256:${Bun.SHA256.hash(body, "hex")}`,
					browser_download_url: `https://github.com/MarsAI-org/mars-agent/releases/download/v${version}/${binaryName}`,
				},
			],
			...overrides,
		};
	}

	it("installs the newest published release when the advertised tag has none", async () => {
		// npm `latest` can name a version GitHub never published: 18.2.9 reached
		// the npm dist-tag while `v18.2.9` 404'd and `v18.2.10` was the newest
		// published release (#12913). Drafts and stable-channel prereleases are
		// not installable, so the scan walks past them.
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const published = "published 999.9.8 binary";
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.endsWith("/releases/tags/v999.9.9")) {
				return new Response(null, { status: 404, statusText: "Not Found" });
			}
			if (requestUrl.includes("/releases?")) {
				return new Response(
					JSON.stringify([
						publishedRelease("999.9.10", "draft binary", { draft: true }),
						publishedRelease("999.9.9-canary.1", "canary binary", { prerelease: true }),
						publishedRelease("999.9.8", published),
					]),
				);
			}
			if (requestUrl.endsWith(`/download/v999.9.8/${binaryName}`)) return new Response(published);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};
		const verified: string[] = [];

		await updateViaBinaryAt(targetPath, "999.9.9", {
			binaryName,
			fetchImpl,
			githubToken: "test-token",
			verifyInstalledVersion: async version => {
				verified.push(version);
				return { ok: true, path: targetPath };
			},
		});

		expect(verified).toEqual(["999.9.8"]);
		expect(await Bun.file(targetPath).text()).toBe(published);
	});

	it("names the missing tag when no published release can replace it", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.includes("/releases/tags/")) {
				return new Response(null, { status: 404, statusText: "Not Found" });
			}
			if (requestUrl.includes("/releases?")) {
				// Older than every real Mars release: installing it would be a downgrade.
				return new Response(JSON.stringify([publishedRelease("0.0.0", content)]));
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		await expect(
			updateViaBinaryAt(targetPath, "999.9.9", { binaryName, fetchImpl, githubToken: "test-token" }),
		).rejects.toThrow("GitHub release v999.9.9 is not published");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("falls back to a prerelease only for canary updates", () => {
		const releases = [publishedRelease("999.9.9", content, { prerelease: true })];

		expect(selectFallbackBinaryAsset(releases, binaryName, "999.0.0")).toBeUndefined();
		expect(selectFallbackBinaryAsset(releases, binaryName, "999.0.0", { allowPrerelease: true })?.version).toBe(
			"999.9.9",
		);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous mars binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
	it("installs at a vacated launcher path when the previous launcher is gone", async () => {
		// Repairing a launcher a failed package-manager reinstall deleted: there
		// is nothing to move aside, so the swap must still land instead of
		// aborting on ENOENT and leaving the user without a launcher.
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(tempPath, "new binary");

		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(result.ok).toBe(true);
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale update artifact sweep", () => {
	it("reclaims timestamped and legacy backups and orphaned temps while sparing in-progress temps and unrelated files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Orphaned temp files from a hard-killed download: reaped once older than
		// the download window. Legacy fixed name and timestamped name both count.
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		await Bun.write(`${targetPath}.new`, "legacy temp");
		await fs.utimes(`${targetPath}.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.new`, "timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new`, stale, stale);
		// Must survive: a fresh temp still belongs to a concurrent, in-progress
		// download (unique per attempt), plus foreign basenames and non-numeric
		// middle segments.
		await Bun.write(`${targetPath}.9999999999999.7.new`, "in-progress temp");
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");
		await Bun.write(`${targetPath}.config.new`, "keep me three");

		await sweepStaleUpdateArtifacts(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.9999999999999.7.new`).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.new`).exists()).toBe(true);
	});
});

describe.skipIf(process.platform !== "darwin")("update-cli macOS live backup images", () => {
	// Regression for the macOS TCC image-path requirement: a `.bak` is the
	// previous executable and another process may still be running it, so it
	// must survive both the immediate post-swap cleanup and later sweeps until
	// its image exits, then be reclaimable. `process.execPath` under `bun
	// test` is the bun runtime — a real Mach-O whose copy can be held live.
	// (Copies of Apple trust-cache binaries like /bin/sleep are SIGKILLed by
	// macOS when executed from a new path, so they cannot serve here.)
	it("retains a backup whose image a live process runs across cleanup and sweep, then reclaims it after the process exits", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		await fs.copyFile(process.execPath, targetPath);
		const live = Bun.spawn([targetPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" });
		try {
			// Real-time waits, not fake timers: these wait on genuine kernel and
			// process state (lsof visibility of the live image, vnode release
			// after exit) that no in-test clock controls.
			// The image must actually be live and visible to lsof, or the
			// retention assertions below would pass for the wrong reason.
			let liveImageVisible = false;
			for (let i = 0; i < 20 && !liveImageVisible; i++) {
				const seen = Bun.spawnSync(["/usr/sbin/lsof", "-t", "--", targetPath]);
				liveImageVisible = seen.exitCode === 0 && seen.stdout.toString().includes(String(live.pid));
				if (!liveImageVisible) await Bun.sleep(100);
			}
			expect(liveImageVisible).toBe(true);

			const attempt = "1700000000000.4242";
			const tempPath = `${targetPath}.${attempt}.new`;
			const backupPath = `${targetPath}.${attempt}.bak`;
			await Bun.write(tempPath, "new binary");

			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
			// The swap landed and the temp was consumed, but the live image's
			// backup must remain on disk.
			expect(await Bun.file(targetPath).text()).toBe("new binary");
			expect(await Bun.file(tempPath).exists()).toBe(false);
			expect(await Bun.file(backupPath).exists()).toBe(true);

			// A later sweep must spare it too.
			await sweepStaleUpdateArtifacts(targetPath);
			expect(await Bun.file(backupPath).exists()).toBe(true);

			live.kill();
			await live.exited;

			// Once the image is gone, the backup is reclaimable.
			for (let i = 0; i < 20 && (await Bun.file(backupPath).exists()); i++) {
				await sweepStaleUpdateArtifacts(targetPath);
				await Bun.sleep(100);
			}
			expect(await Bun.file(backupPath).exists()).toBe(false);
		} finally {
			live.kill();
			await live.exited;
		}
	});
});

describe("update-cli script-shim takeover", () => {
	const version = "18.0.0";
	const binaryName = "mars-windows-x64.exe";
	const url = `https://github.com/MarsAI-org/mars-agent/releases/download/v${version}/${binaryName}`;

	function makeFetch(content: string, prerelease = false): (input: string | URL | Request) => Promise<Response> {
		const digest = `sha256:${Bun.SHA256.hash(content, "hex")}`;
		return async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) {
				return new Response(
					JSON.stringify({
						tag_name: `v${version}`,
						draft: false,
						prerelease,
						assets: [
							{
								name: binaryName,
								state: "uploaded",
								size: Buffer.byteLength(content),
								digest,
								browser_download_url: url,
							},
						],
					}),
				);
			}
			if (requestUrl === url) return new Response(content);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};
	}

	const shims: Record<string, string> = {
		mars: "#!/bin/sh\nnode mars.js\n",
		"mars.cmd": "@node mars.js %*\n",
		"mars.ps1": "node mars.js @args\n",
	};

	async function writeShims(dir: string): Promise<void> {
		for (const name in shims) {
			await Bun.write(path.join(dir, name), shims[name]);
		}
	}

	/**
	 * The fake release binaries are `#!/bin/sh` scripts, which Windows cannot
	 * launch as `mars.exe`. There, "run" the explicit path the takeover verifies
	 * by reading the version the script echoes; POSIX hosts execute it for real.
	 */
	const verifyBinary =
		process.platform === "win32"
			? async (binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> => {
					const script = await Bun.file(binaryPath).text();
					const actual = parseReportedVersion(script.match(/^echo (.+)$/m)?.[1] ?? "");
					return { ok: actual === expectedVersion, actual, path: binaryPath };
				}
			: undefined;

	it("installs mars.exe beside the shims and retires them", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// Real executable, no injected verifier: the takeover must verify the
		// exe by explicit path — $which cached the shim path before it was
		// renamed away, so a PATH re-resolution would fail here.
		const exe = `#!/bin/sh\necho mars/${version}\n`;

		await updateViaShimTakeover(path.join(dir, "mars.cmd"), version, {
			binaryName,
			fetchImpl: makeFetch(exe),
			githubToken: "test-token",
			verifyBinary,
		});

		expect(await Bun.file(path.join(dir, "mars.exe")).text()).toBe(exe);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).exists()).toBe(false);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	it("installs a canary prerelease binary only when the caller opts in", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = `#!/bin/sh\necho mars/${version}\n`;

		// A canary release is published as a prerelease: without opt-in the
		// takeover refuses the asset and leaves the shims intact.
		await expect(
			updateViaShimTakeover(path.join(dir, "mars.cmd"), version, {
				binaryName,
				fetchImpl: makeFetch(exe, true),
				githubToken: "test-token",
				verifyBinary,
			}),
		).rejects.toThrow("is a prerelease");
		expect(await Bun.file(path.join(dir, "mars.exe")).exists()).toBe(false);

		// allowPrerelease threads through to the asset resolver, so the canary
		// exe installs and the shims are retired.
		await updateViaShimTakeover(path.join(dir, "mars.cmd"), version, {
			binaryName,
			fetchImpl: makeFetch(exe, true),
			allowPrerelease: true,
			githubToken: "test-token",
			verifyBinary,
		});
		expect(await Bun.file(path.join(dir, "mars.exe")).text()).toBe(exe);
	});

	it("drops bun's launcher metadata when the standalone binary takes the .exe over", async () => {
		// After the takeover the launcher is no longer bun-managed. A leftover
		// `omp.bunx` would keep classifying the install as bun-managed and send
		// the next update through `bun install -g`, which cannot overwrite the
		// running `.exe` and would pin the install to the old version.
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const marker = path.join(dir, "omp.bunx");
		await Bun.write(targetPath, "bun shim");
		await Bun.write(marker, "bun launcher metadata");
		const exe = `#!/bin/sh\necho mars/${version}\n`;

		await updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: makeFetch(exe),
			githubToken: "test-token",
			verifyInstalledVersion: async () => ({ ok: true, actual: version, path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe(exe);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it.skipIf(process.platform === "win32")("reports the physical binary path verified after an update", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		const exe = `#!/bin/sh\necho mars/${version}\n`;
		await Bun.write(targetPath, "old binary");
		const logSpy = spyOn(console, "log").mockImplementation(() => {});

		await updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: makeFetch(exe),
			githubToken: "test-token",
		});

		expect(
			logSpy.mock.calls.some(
				([message]) => String(message).includes(targetPath) && String(message).includes(version),
			),
		).toBe(true);
	});

	it("restores the shims and removes the exe when the exe reports the wrong version", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// Executable runs but reports the previous version -> full rollback.
		const exe = "#!/bin/sh\necho mars/17.2.12\n";

		await expect(
			updateViaShimTakeover(path.join(dir, "mars.cmd"), version, {
				binaryName,
				fetchImpl: makeFetch(exe),
				githubToken: "test-token",
				verifyBinary,
			}),
		).rejects.toThrow(/still reports 17\.2\.12 \(expected 18\.0\.0\); restored previous mars launcher/);

		expect(await Bun.file(path.join(dir, "mars.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	function renameLockingPs1(): Mock<typeof nodeFs.promises.rename> {
		const realRename = nodeFs.promises.rename;
		return spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (path.basename(String(from)) === "mars.ps1") {
				throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
			}
			return await realRename(from, to);
		});
	}

	it("rewrites an immovable precedence-winning shim as a forwarder to the exe", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = `#!/bin/sh\necho mars/${version}\n`;
		const renameSpy = renameLockingPs1();
		try {
			await updateViaShimTakeover(path.join(dir, "mars.cmd"), version, {
				binaryName,
				fetchImpl: makeFetch(exe),
				githubToken: "test-token",
				verifyBinary,
			});
		} finally {
			renameSpy.mockRestore();
		}

		expect(await Bun.file(path.join(dir, "mars.exe")).text()).toBe(exe);
		expect(await Bun.file(path.join(dir, "mars")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "mars.cmd")).exists()).toBe(false);
		// PowerShell resolves .ps1 before .exe: the locked shim must now exec
		// the new binary instead of keeping its old body.
		expect(await Bun.file(path.join(dir, "mars.ps1")).text()).toContain('& "$PSScriptRoot\\mars.exe" @args');
	});

	it("restores a forwarded shim's original body when verification fails", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = "#!/bin/sh\necho mars/17.2.12\n";
		const renameSpy = renameLockingPs1();
		try {
			await expect(
				updateViaShimTakeover(path.join(dir, "omp.cmd"), version, {
					binaryName,
					fetchImpl: makeFetch(exe),
					githubToken: "test-token",
					verifyBinary,
				}),
			).rejects.toThrow("restored previous mars launcher");
		} finally {
			renameSpy.mockRestore();
		}

		expect(await Bun.file(path.join(dir, "mars.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
	});
});

describe("update-cli concurrent binary updates", () => {
	const version = "999.0.0";
	const binaryName = "mars-linux-x64";
	const url = `https://github.com/MarsAI-org/mars-agent/releases/download/v${version}/${binaryName}`;
	const payload = Buffer.alloc(2048, 0x41);
	const digest = `sha256:${Bun.SHA256.hash(payload, "hex")}`;

	function metadata(): Response {
		return Response.json({
			tag_name: `v${version}`,
			draft: false,
			prerelease: false,
			assets: [{ name: binaryName, state: "uploaded", size: payload.byteLength, digest, browser_download_url: url }],
		});
	}

	const fastFetch = async (input: string | URL | Request): Promise<Response> => {
		const requestUrl = String(input);
		if (requestUrl.startsWith("https://api.github.com/")) return metadata();
		if (requestUrl === url) return new Response(payload);
		throw new Error(`Unexpected request: ${requestUrl}`);
	};

	const verify = async () => ({ ok: true, actual: version });

	async function prepare(): Promise<{ dir: string; targetPath: string }> {
		const loadedTheme = await getThemeByName("dark");
		if (!loadedTheme) throw new Error("theme unavailable");
		setThemeInstance(loadedTheme);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "mars");
		await Bun.write(targetPath, "old binary");
		return { dir, targetPath };
	}

	// Regression for #8434: two overlapping `mars update` runs must not share a
	// temp path. Run A downloads slowly and only finishes after run B has fully
	// installed. With the old fixed `<binary>.new` temp name, B's pre-download
	// unlink deleted A's temp file, so A's chmod failed with ENOENT even though
	// its size + digest passed. Unique temp paths keep the two runs independent.
	it("lets an overlapping slow run install after a fast run completes, instead of failing chmod with ENOENT", async () => {
		const { dir, targetPath } = await prepare();

		const aWroteFirstChunk = Promise.withResolvers<void>();
		const letAFinish = Promise.withResolvers<void>();
		const slowFetch = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) return metadata();
			if (requestUrl === url) {
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(payload.subarray(0, 1024));
							aWroteFirstChunk.resolve();
							await letAFinish.promise;
							controller.enqueue(payload.subarray(1024));
							controller.close();
						},
					}),
				);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const runA = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: slowFetch,
			verifyInstalledVersion: verify,
		});
		await aWroteFirstChunk.promise;
		await updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyInstalledVersion: verify,
		});
		letAFinish.resolve();
		await runA;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	// Regression: a failed verification must still roll back its own backup even
	// when another update completes while it is held. The per-target lock
	// serializes the swap + sweep, so the concurrent run's sweep cannot reclaim
	// the live backup before the rollback renames it back.
	it("rolls back its backup when verification fails while another update runs", async () => {
		const { dir, targetPath } = await prepare();

		const enteredVerify = Promise.withResolvers<void>();
		const releaseVerify = Promise.withResolvers<void>();
		const failingVerify = async () => {
			enteredVerify.resolve();
			await releaseVerify.promise;
			return { ok: false, actual: "0.0.0", path: targetPath };
		};

		const runA = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyInstalledVersion: failingVerify,
		});
		await enteredVerify.promise;
		const runB = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			verifyInstalledVersion: verify,
		});
		releaseVerify.resolve();
		await expect(runA).rejects.toThrow(/still reports 0\.0\.0 \(expected 999\.0\.0\)/);
		await runB;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});
});

describe("update-cli GitHub release listing", () => {
	it("reports the newest published release, skipping drafts and prereleases", async () => {
		const fetchImpl = async (): Promise<Response> =>
			new Response(
				JSON.stringify([
					{ tag_name: "v0.9.0", draft: true, prerelease: false, assets: [] },
					{ tag_name: "v0.8.0", draft: false, prerelease: true, assets: [] },
					{ tag_name: "v0.2.0", draft: false, prerelease: false, assets: [] },
					{ tag_name: "v0.1.0", draft: false, prerelease: false, assets: [] },
				]),
			);
		expect(await updateCli.getLatestPublishedRelease(fetchImpl, "test-token")).toBe("0.2.0");
		expect(await updateCli.getLatestPublishedRelease(fetchImpl, "test-token", true)).toBe("0.8.0");
	});
});
