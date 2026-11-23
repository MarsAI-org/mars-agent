/**
 * Update CLI command handler.
 *
 * Handles `mars update` to check for and install updates from GitHub Releases.
 * Uses the installer that owns the active mars executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { theme } from "@marsai-org/tui/theme";
import { $env, $which, APP_NAME, compareVersions, isEnoent, VERSION } from "@marsai-org/utils";
import chalk from "@marsai-org/utils/chalk";
import { withFileLock } from "@marsai-org/utils/file-lock";
import { $ } from "bun";
import { settings } from "../config/settings";
import { cfgUpdateChannel } from "../modes/settings";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

const REPO = "MarsAI-org/mars-agent";
const MISE_TOOL = "github:MarsAI-org/mars-agent";
const NIX_STORE_DIR = "/nix/store";
const GITHUB_API = "https://api.github.com";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type UpdateChannel = "stable" | "canary";

export interface ReleaseInfo {
	tag: string;
	version: string;
}

/** A release binary the updater can download, resolved from published GitHub release metadata. */
export interface ReleaseBinaryAsset {
	/** Release version the asset installs, without the `v` tag prefix. */
	version: string;
	url: string;
	size: number;
	digest: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubCliTokenRunner = (ghPath: string) => Promise<string | undefined>;

async function readGitHubCliToken(ghPath: string): Promise<string | undefined> {
	try {
		const result = await $`${ghPath} auth token --hostname github.com`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const token = result.text().trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

async function resolveGitHubToken(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	const envToken = options.envToken ?? ($env.GITHUB_TOKEN || $env.GH_TOKEN);
	if (envToken) return envToken;

	const ghPath = options.ghPath === null ? undefined : (options.ghPath ?? $which("gh"));
	if (!ghPath) return undefined;

	const token = await (options.runGhAuthToken ?? readGitHubCliToken)(ghPath);
	return token?.trim() || undefined;
}

/** Test hook for the GitHub credential precedence without invoking a real CLI. */
export async function resolveGitHubTokenForTest(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	return resolveGitHubToken(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Select and validate the binary asset from GitHub release metadata.
 *
 * Draft releases are always rejected. Prereleases are rejected unless
 * `options.allowPrerelease` is set, which the canary channel passes: canary
 * GitHub releases are published as prereleases, and the exact-tag match below
 * still pins the download to the specific requested version.
 */
export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
	options: { allowPrerelease?: boolean } = {},
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false) {
		throw new Error(`GitHub release ${expectedTag} is a draft, not a published release`);
	}
	if (release.prerelease !== false && !options.allowPrerelease) {
		throw new Error(`GitHub release ${expectedTag} is a prerelease; only canary updates install prerelease assets`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${REPO}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}

	return {
		version: expectedTag.replace(/^v/, ""),
		url: expectedUrl,
		size: asset.size,
		digest: `sha256:${digest.toLowerCase()}`,
	};
}

/**
 * Newest published release that is installable on this platform and newer than
 * `minVersion`, or undefined when the listing holds none.
 *
 * Releases whose asset is missing, still uploading, draft, or off-channel are
 * skipped in favor of an older published one.
 */
export function selectFallbackBinaryAsset(
	releases: unknown,
	binaryName: string,
	minVersion: string,
	options: { allowPrerelease?: boolean } = {},
): ReleaseBinaryAsset | undefined {
	if (!Array.isArray(releases)) return undefined;
	const candidates: Array<{ tag: string; release: unknown }> = [];
	for (const release of releases) {
		if (!isRecord(release)) continue;
		const tag = release.tag_name;
		if (typeof tag !== "string" || !/^v\d/.test(tag)) continue;
		if (compareVersions(tag.slice(1), minVersion) <= 0) continue;
		candidates.push({ tag, release });
	}
	candidates.sort((a, b) => compareVersions(b.tag.slice(1), a.tag.slice(1)));
	for (const { tag, release } of candidates) {
		try {
			return resolveReleaseBinaryAsset(release, tag, binaryName, options);
		} catch {
			// Draft, off-channel prerelease, or an asset that is missing or still
			// uploading: keep walking down to an older published release.
		}
	}
	return undefined;
}

/** Release metadata request with the shared headers, timeout, and rate-limit mapping. */
async function fetchReleaseMetadata(
	url: string,
	fetchImpl: Fetch,
	token: string | undefined,
	timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS,
): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetchImpl(url, { headers, signal: withTimeoutSignal(timeoutMs) });
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching GitHub release metadata after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if ((response.status === 403 && !token) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	return response;
}

/** Releases scanned when resolving latest or fallback tags; one page spans months of releases. */
const RELEASE_LISTING_PAGE_SIZE = 30;

/**
 * Newest version this project has actually published a GitHub release for.
 */
export async function getLatestPublishedRelease(
	fetchImpl: Fetch = fetch,
	githubToken?: string,
	allowPrerelease = false,
	timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS,
): Promise<string | undefined> {
	const token = githubToken ?? (await resolveGitHubToken());
	const listing = await fetchReleaseMetadata(
		`${GITHUB_API}/repos/${REPO}/releases?per_page=${RELEASE_LISTING_PAGE_SIZE}`,
		fetchImpl,
		token,
		timeoutMs,
	);
	if (!listing.ok) return undefined;
	const releases = await listing.json();
	if (!Array.isArray(releases)) return undefined;
	let newest: string | undefined;
	for (const release of releases) {
		if (!isRecord(release)) continue;
		const tag = release.tag_name;
		if (typeof tag !== "string" || !/^v\d/.test(tag)) continue;
		if (release.draft !== false) continue;
		if (release.prerelease === true && !allowPrerelease) continue;
		const version = tag.slice(1);
		if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
	}
	return newest;
}

/**
 * Get the latest published release from GitHub Releases for the requested channel.
 */
export async function getLatestRelease(
	options: { timeoutMs?: number; channel?: UpdateChannel; fetchImpl?: Fetch; githubToken?: string } = {},
): Promise<ReleaseInfo> {
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	const channel = options.channel ?? "stable";
	const fetchImpl = options.fetchImpl ?? fetch;
	const token = options.githubToken ?? (await resolveGitHubToken());
	const listing = await fetchReleaseMetadata(
		`${GITHUB_API}/repos/${REPO}/releases?per_page=${RELEASE_LISTING_PAGE_SIZE}`,
		fetchImpl,
		token,
		timeoutMs,
	);
	if (!listing.ok) {
		throw new Error(`Failed to fetch GitHub releases for ${REPO}: ${listing.status} ${listing.statusText}`);
	}
	const releases = await listing.json();
	if (!Array.isArray(releases)) {
		throw new Error(`Malformed GitHub releases response for ${REPO}`);
	}
	const allowPrerelease = channel === "canary";
	let newest: string | undefined;
	let hasPrerelease = false;
	for (const release of releases) {
		if (!isRecord(release)) continue;
		const tag = release.tag_name;
		if (typeof tag !== "string" || !/^v\d/.test(tag)) continue;
		if (release.draft !== false) continue;
		if (release.prerelease === true) {
			if (!allowPrerelease) continue;
			hasPrerelease = true;
		}
		const version = tag.slice(1);
		if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
	}
	if (channel === "canary" && !hasPrerelease) {
		throw new Error(`No canary release has been published for ${APP_NAME} yet. Try \`${APP_NAME} update --stable\`.`);
	}
	if (!newest) {
		throw new Error(`No published GitHub release found for ${REPO}`);
	}
	return { tag: `v${newest}`, version: newest };
}

async function getReleaseBinaryAsset(
	expectedVersion: string,
	binaryName: string,
	fetchImpl: Fetch = fetch,
	githubToken?: string,
	allowPrerelease = false,
): Promise<ReleaseBinaryAsset> {
	const tag = `v${expectedVersion}`;
	const token = githubToken ?? (await resolveGitHubToken());
	const response = await fetchReleaseMetadata(
		`${GITHUB_API}/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
		fetchImpl,
		token,
	);
	if (response.ok) {
		return resolveReleaseBinaryAsset(await response.json(), tag, binaryName, { allowPrerelease });
	}
	if (response.status !== 404) {
		throw new Error(`Failed to fetch GitHub release metadata: ${response.statusText}`);
	}

	const listing = await fetchReleaseMetadata(
		`${GITHUB_API}/repos/${REPO}/releases?per_page=${RELEASE_LISTING_PAGE_SIZE}`,
		fetchImpl,
		token,
	);
	if (!listing.ok) {
		throw new Error(
			`GitHub release ${tag} is not published and listing published releases failed: ${listing.statusText}`,
		);
	}
	const fallback = selectFallbackBinaryAsset(await listing.json(), binaryName, VERSION, { allowPrerelease });
	if (!fallback) {
		throw new Error(
			`GitHub release ${tag} is not published, and no newer published release ships ${binaryName}; retry once the release finishes publishing, or reinstall with: ${installerHint()}`,
		);
	}
	console.log(
		chalk.yellow(
			`GitHub release ${tag} is not published; installing the newest published binary release v${fallback.version} instead.`,
		),
	);
	return fallback;
}

export interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
}

/**
 * Download a binary and verify its GitHub-reported size and SHA-256 digest.
 */
export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = new Bun.SHA256();
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(
	args: string[],
): { force: boolean; check: boolean; plugins: boolean; channel?: UpdateChannel } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	const canary = args.includes("--canary");
	const stable = args.includes("--stable");
	if (canary && stable) throw new Error("--canary and --stable are mutually exclusive");

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
		channel: canary ? "canary" : stable ? "stable" : undefined,
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return process.platform === "win32" ? prefix : path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	// Probe only a Mars-named formula. The upstream oh-my-pi formula
	// (`can1357/tap/omp`) must never be resolved here: classifying a foreign
	// install as Homebrew-managed would let the update path upgrade Mars into a
	// different product.
	try {
		const result = await $`brew --prefix ${APP_NAME}`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		if (output.length > 0) return output;
	} catch {}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isSymlinkPath(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Windows script shims (legacy package-manager launchers) that a native executable cannot overwrite directly. */
function isWindowsScriptLauncherPath(launcherPath: string): boolean {
	const extension = path.extname(launcherPath).toLowerCase();
	return extension === ".cmd" || extension === ".ps1" || extension === ".bat";
}

/**
 * Path of bun's Windows launcher metadata sidecar for `launcherPath`.
 *
 * Legacy bun global installs write a `<name>.bunx` / `<name>.exe` pair; removing
 * the sidecar after a binary takeover keeps subsequent updates clean.
 */
function bunShimMarkerPath(launcherPath: string): string {
	const base = path.basename(launcherPath, path.extname(launcherPath));
	return path.join(path.dirname(launcherPath), `${base}.bunx`);
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard so symlinks and
	// Windows junctions (e.g. Scoop's ~/.bun junction or Homebrew Cellar links)
	// match their containing directory.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function isPathInManagerRoot(linkTarget: string, nodeModulesDir: string): boolean {
	if (isPathInDirectoryLexical(linkTarget, nodeModulesDir)) return true;
	// Resolve only the manager root. Resolving the link target itself would
	// follow globally linked packages into their checkout and lose ownership.
	const nodeModulesReal = tryRealpath(path.resolve(nodeModulesDir));
	return nodeModulesReal !== undefined && isPathInDirectoryLexical(linkTarget, nodeModulesReal);
}

interface BunGlobalInstallLocations {
	globalDir?: string;
	globalBinDir?: string;
	cacheDir?: string;
}

/** Resolve Bun's global node_modules root from explicit, default, or cache locations. */
export function resolveBunGlobalNodeModulesDirFromLocations({
	globalDir,
	globalBinDir,
	cacheDir,
}: BunGlobalInstallLocations): string | undefined {
	if (globalDir && globalDir.length > 0) return path.join(globalDir, "node_modules");
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
}

function resolveNpmGlobalNodeModulesDir(globalBinDir: string | undefined): string | undefined {
	if (!globalBinDir) return undefined;
	if (process.platform === "win32") return path.join(globalBinDir, "node_modules");
	return path.join(path.dirname(globalBinDir), "lib", "node_modules");
}

function isManagerOwnedBinEntry(linkTarget: string | undefined, nodeModulesDir: string | undefined): boolean {
	return linkTarget === undefined || (nodeModulesDir !== undefined && isPathInManagerRoot(linkTarget, nodeModulesDir));
}

type UpdateMethod = "brew" | "mise" | "nix" | "shim" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
	/** Bun's configured global package directory, independent of its bin directory. */
	bunGlobalDir?: string;
	/**
	 * Whether the resolved mars path is a plain file rather than a symlink.
	 */
	ompIsRegularFile?: boolean;
	/**
	 * Absolute path named by the bin entry's first symlink hop.
	 */
	ompLinkTarget?: string;
}

type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "nix" }
	| { method: "shim"; path: string }
	| { method: "binary"; path: string; replacesSymlink: boolean; validateExistingTarget: boolean };

function isLegacyPackageManagerLauncher(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions,
): boolean {
	const { bunGlobalDir, npmBinDir, ompIsRegularFile = false, ompLinkTarget } = options;
	if (ompIsRegularFile) return false;
	const bunNodeModulesDir = resolveBunGlobalNodeModulesDirFromLocations({
		globalDir: bunGlobalDir,
		globalBinDir: bunBinDir,
	});
	const realBunBinDir = bunBinDir ? tryRealpath(bunBinDir) : undefined;
	const realBunNodeModulesDir =
		realBunBinDir && realBunBinDir !== bunBinDir
			? resolveBunGlobalNodeModulesDirFromLocations({ globalDir: bunGlobalDir, globalBinDir: realBunBinDir })
			: undefined;
	if (
		bunBinDir &&
		isPathInDirectory(ompPath, bunBinDir) &&
		(isManagerOwnedBinEntry(ompLinkTarget, bunNodeModulesDir) ||
			(realBunNodeModulesDir !== undefined && isManagerOwnedBinEntry(ompLinkTarget, realBunNodeModulesDir)))
	) {
		return true;
	}
	const npmNodeModulesDir = resolveNpmGlobalNodeModulesDir(npmBinDir);
	const realNpmBinDir = npmBinDir ? tryRealpath(npmBinDir) : undefined;
	const realNpmNodeModulesDir =
		realNpmBinDir && realNpmBinDir !== npmBinDir ? resolveNpmGlobalNodeModulesDir(realNpmBinDir) : undefined;
	if (
		npmBinDir &&
		isPathInDirectory(ompPath, npmBinDir) &&
		(isManagerOwnedBinEntry(ompLinkTarget, npmNodeModulesDir) ||
			(realNpmNodeModulesDir !== undefined && isManagerOwnedBinEntry(ompLinkTarget, realNpmNodeModulesDir)))
	) {
		return true;
	}
	return false;
}

function resolveUpdateMethod(
	ompPath: string,
	_bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir } = options;
	if (isPathInDirectory(ompPath, NIX_STORE_DIR)) return "nix";
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	if (isWindowsScriptLauncherPath(ompPath)) return "shim";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

/** Resolve an update target from the concrete PATH entry selected by the shell. */
export function resolveUpdateTargetFromPath(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateTarget {
	let ompIsRegularFile = false;
	let ompIsSymlink = false;
	let ompLinkTarget: string | undefined;
	let ompRealpath: string | undefined;
	try {
		const stat = fs.lstatSync(ompPath);
		ompIsRegularFile = stat.isFile() && !stat.isSymbolicLink();
		ompIsSymlink = stat.isSymbolicLink();
		if (ompIsSymlink) {
			const rawTarget = fs.readlinkSync(ompPath);
			const linkDir = path.dirname(ompPath);
			ompLinkTarget = path.resolve(tryRealpath(linkDir) ?? linkDir, rawTarget);
			ompRealpath = tryRealpath(ompPath);
		}
	} catch {}

	const method = resolveUpdateMethod(ompPath, bunBinDir, {
		...options,
		ompIsRegularFile,
		ompLinkTarget,
	});
	if (method === "binary") {
		// A symlinked launcher created by a legacy bun/npm global install is
		// taken over in place with the standalone binary so the PATH entry stays
		// live. Every other symlink — a foreign alias or an admin symlink into a
		// shared install — resolves to the real binary it points to and leaves
		// the launcher untouched.
		const legacyManagerLauncher =
			ompIsSymlink &&
			isLegacyPackageManagerLauncher(ompPath, bunBinDir, {
				...options,
				ompIsRegularFile,
				ompLinkTarget,
			});
		const binaryPath = ompIsSymlink && !legacyManagerLauncher ? (ompRealpath ?? ompPath) : ompPath;
		return {
			method,
			path: binaryPath,
			replacesSymlink: ompIsSymlink && binaryPath === ompPath,
			validateExistingTarget: ompIsSymlink && !legacyManagerLauncher,
		};
	}
	if (method === "shim") return { method, path: ompPath };
	return { method };
}

/**
 * Resolve how the running install should be updated.
 *
 * Mars distributes releases via GitHub Releases (standalone binaries, mise, and
 * Nix). For symlinked launchers, legacy bun/npm bin dirs are probed only to
 * distinguish a legacy package-manager symlink (taken over in place) from a
 * foreign symlink (resolved to its real binary).
 */
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();

	if (!ompPath) {
		throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
	}

	const probeManagers = isSymlinkPath(ompPath);
	const bunBinDir = probeManagers ? await getBunGlobalBinDir() : undefined;
	const npmBinDir = probeManagers ? await getNpmGlobalBinDir() : undefined;

	return resolveUpdateTargetFromPath(ompPath, bunBinDir, {
		bunGlobalDir: probeManagers ? process.env.BUN_INSTALL_GLOBAL_DIR : undefined,
		homebrewPrefix,
		miseBinDirs,
		miseDataDir,
		npmBinDir,
	});
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl release asset instead of the glibc build, which
 * would fail to start on the next run. The loader file alone is not sufficient:
 * glibc hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform?: NodeJS.Platform;
	alpineRelease?: boolean;
	lddOutput?: string;
}

function detectLddOutput(): string | undefined {
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return undefined;
	}
}

function isMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: Required<MuslDetectionOptions>): boolean {
	return isMuslLinux(options);
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let osName: string;
	switch (platform) {
		case "linux":
			osName = isMuslLinux() ? "linux-musl" : "linux";
			break;
		case "darwin":
			osName = "darwin";
			break;
		case "win32":
			osName = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (osName === "windows") {
		return `${APP_NAME}-${osName}-${archName}.exe`;
	}
	return `${APP_NAME}-${osName}-${archName}`;
}

/**
 * Resolve the path that `mars` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Parse the version a launcher reports from `mars --version` output
 * (`mars/X.Y.Z`, or a prerelease such as `mars/X.Y.Z-canary.1`).
 */
export function parseReportedVersion(output: string): string | undefined {
	if (!output.startsWith(`${APP_NAME}/`)) return undefined;
	return output.slice(APP_NAME.length + 1).match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
}

async function reportedVersionAtPath(binaryPath: string): Promise<string | undefined> {
	try {
		const result = await $`${binaryPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		return parseReportedVersion(result.text().trim());
	} catch {
		return undefined;
	}
}

/**
 * Run a specific binary and check if it reports the expected version.
 */
async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	const actual = await reportedVersionAtPath(binaryPath);
	return { ok: actual === expectedVersion, actual, path: binaryPath };
}

async function validateExistingUpdateTarget(targetPath: string): Promise<void> {
	let hasShebang = false;
	try {
		hasShebang = (await Bun.file(targetPath).slice(0, 2).text()) === "#!";
	} catch {}

	if (!hasShebang && (await reportedVersionAtPath(targetPath)) !== undefined) return;

	const reason = hasShebang
		? "is a shebang script, not a Mars binary"
		: "does not report a Mars version when run directly";
	throw new Error(
		`Refusing to replace ${targetPath}: the resolved foreign symlink target ${reason}. Point PATH directly at the Mars binary you want to update, or reinstall with: ${installerHint()}`,
	);
}

/**
 * Run the PATH-resolved mars binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	const binaryPath = tryRealpath(ompPath) ?? ompPath;
	return await verifyBinaryAtPath(binaryPath, expectedVersion);
}

function printVerifiedVersion(expectedVersion: string, binaryPath?: string): void {
	const icon = theme?.status?.success ?? "✔";
	const location = binaryPath ? ` at ${binaryPath}` : "";
	console.log(chalk.green(`\n${icon} Updated to ${expectedVersion}${location}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
function printVerificationResult(result: InstalledVersionVerification, expectedVersion: string): void {
	if (result.ok) {
		printVerifiedVersion(expectedVersion, result.path);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow(`You may need to reinstall: ${installerHint()}`));
}

/** Verify the PATH-resolved launcher and print the outcome. */
async function printVerification(expectedVersion: string): Promise<void> {
	printVerificationResult(await verifyInstalledVersion(expectedVersion), expectedVersion);
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). On macOS the same unlink would instead succeed
 * while breaking the live process's TCC permission attribution — macOS
 * resolves grants against the executable's on-disk image path — so a `.bak`
 * still mapped by any process is retained for a later sweep.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	if (process.platform === "darwin" && filePath.endsWith(".bak")) {
		let provenUnused = false;
		try {
			const result = await $`/usr/sbin/lsof -t -- ${filePath}`.quiet().nothrow();
			provenUnused = result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0;
		} catch {
			// lsof missing or failed to spawn — retain conservatively.
		}
		if (!provenUnused) return false;
	}
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update leftovers from earlier runs.
 */
export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak") ? ".bak" : entry.endsWith(".new") ? ".new" : undefined;
		if (!suffix) continue;
		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		const full = path.join(dir, entry);
		if (suffix === ".new") {
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		try {
			await fs.promises.rename(options.targetPath, options.backupPath);
			backupReady = true;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Explain why a Homebrew-managed Mars install cannot self-update.
 *
 * Mars does not publish a Homebrew tap or formula, so there is no Mars formula
 * to upgrade. The only safe instruction is to reinstall through a supported
 * channel; upgrading an upstream oh-my-pi formula would replace Mars with a
 * different product.
 */
export function homebrewUpdateRefusal(): string {
	return `Mars is not distributed through Homebrew; reinstall with the official installer (${installerHint()}).`;
}

/**
 * Build the attended mise update command.
 */
export function buildMiseUpgradeArgs(supportsReleaseAgeOverride = true): string[] {
	return ["upgrade", MISE_TOOL, "--bump", ...(supportsReleaseAgeOverride ? ["--before", "0s"] : [])];
}

export function buildMiseUpdateEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	return { ...base, MISE_MINIMUM_RELEASE_AGE: "0s" };
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

async function updateViaMise(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating via mise..."));
	const env = buildMiseUpdateEnv();
	const help = await $`mise upgrade --help`.env(env).quiet().nothrow();
	const supportsReleaseAgeOverride = help.exitCode === 0 && /(?:--minimum-release-age|--before)\b/.test(help.text());
	const args = buildMiseUpgradeArgs(supportsReleaseAgeOverride);
	const result = await $`mise ${args}`.env(env).nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.env(env).nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion);
}

// Monotonic within this process so two updates started in the same millisecond
// still get distinct temp/backup paths.
let updateAttemptSeq = 0;

/**
 * Download a release binary to a target path, replacing an existing file.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		allowPrerelease?: boolean;
		/** Refuse replacement unless the existing path is a non-script Mars executable. */
		validateExistingTarget?: boolean;
		verifyInstalledVersion?: typeof verifyInstalledVersion;
	} = {},
): Promise<void> {
	if (options.validateExistingTarget) await validateExistingUpdateTarget(targetPath);
	const binaryName = options.binaryName ?? getBinaryName();
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	const asset = await getReleaseBinaryAsset(
		expectedVersion,
		binaryName,
		options.fetchImpl,
		options.githubToken,
		options.allowPrerelease,
	);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));

	const verification = await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: asset.version,
			verifyInstalledVersion: options.verifyInstalledVersion ?? (version => verifyBinaryAtPath(targetPath, version)),
		});
		try {
			await unlinkIfExists(bunShimMarkerPath(targetPath));
		} catch {}
		await sweepStaleUpdateArtifacts(targetPath);
		return result;
	});
	printVerifiedVersion(asset.version, verification.path ?? targetPath);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * In-place forwarder bodies, by shim extension, for legacy Windows script
 * launchers that cannot be renamed aside during a takeover; each execs the
 * sibling `mars.exe`.
 */
const SHIM_FORWARDERS: Record<string, string> = {
	"": `#!/bin/sh\nexec "$(dirname "$0")/${APP_NAME}.exe" "$@"\n`,
	".cmd": `@"%~dp0${APP_NAME}.exe" %*\r\n`,
	".bat": `@"%~dp0${APP_NAME}.exe" %*\r\n`,
	".ps1": `& "$PSScriptRoot\\${APP_NAME}.exe" @args\nexit $LASTEXITCODE\n`,
};

/**
 * Take over a legacy Windows script-launcher install with the standalone release binary.
 */
export async function updateViaShimTakeover(
	shimPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		allowPrerelease?: boolean;
		verifyBinary?: typeof verifyBinaryAtPath;
	} = {},
): Promise<void> {
	const binaryName = options.binaryName ?? getBinaryName();
	const launcherDir = path.dirname(shimPath);
	const exePath = path.join(launcherDir, `${APP_NAME}.exe`);
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${exePath}.${attempt}.new`;
	const asset = await getReleaseBinaryAsset(
		expectedVersion,
		binaryName,
		options.fetchImpl,
		options.githubToken,
		options.allowPrerelease,
	);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));
	const forwarded: Array<{ launcher: string; original: string }> = [];
	const stuck: string[] = [];
	await withFileLock(exePath, async () => {
		console.log(chalk.dim(`Installing ${APP_NAME}.exe beside the script launcher...`));
		await fs.promises.rename(tempPath, exePath);
		const backupSuffix = `${attempt}.bak`;
		const retired: Array<{ launcher: string; backup: string }> = [];
		for (const ext of ["", ".cmd", ".ps1", ".bat"]) {
			const launcher = path.join(launcherDir, `${APP_NAME}${ext}`);
			const backup = `${launcher}.${backupSuffix}`;
			try {
				await fs.promises.rename(launcher, backup);
				retired.push({ launcher, backup });
			} catch (err) {
				if (isEnoent(err)) continue;
				try {
					const original = await Bun.file(launcher).text();
					await Bun.write(launcher, SHIM_FORWARDERS[ext]);
					forwarded.push({ launcher, original });
				} catch {
					stuck.push(launcher);
				}
			}
		}

		const verify = options.verifyBinary ?? verifyBinaryAtPath;
		const verification = await verify(exePath, asset.version);
		if (!verification.ok) {
			for (const { launcher, backup } of retired) {
				try {
					await fs.promises.rename(backup, launcher);
				} catch {}
			}
			for (const { launcher, original } of forwarded) {
				try {
					await Bun.write(launcher, original);
				} catch {}
			}
			await unlinkIfExists(exePath);
			throw new Error(
				`${formatVerificationFailure(verification, asset.version)}; restored previous ${APP_NAME} launcher`,
			);
		}
		for (const { backup } of retired) {
			await removeBackupBestEffort(backup);
		}
		for (const ext of [".exe", "", ".cmd", ".ps1", ".bat"]) {
			await sweepStaleUpdateArtifacts(path.join(launcherDir, `${APP_NAME}${ext}`));
		}
	});
	for (const { launcher } of forwarded) {
		console.log(chalk.dim(`Converted ${launcher} to a forwarder (it could not be removed).`));
	}
	for (const launcher of stuck) {
		console.log(
			chalk.yellow(
				`Could not retire ${launcher}; shells that prefer it may keep launching the old version until it is deleted manually.`,
			),
		);
	}
	printVerifiedVersion(asset.version);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Platform-appropriate installer one-liner for recovery instructions.
 */
function installerHint(): string {
	return process.platform === "win32"
		? "& ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Binary"
		: "curl -fsSL https://getmars.eu.cc/install | sh -s -- --binary";
}

/** Persisted channel, or undefined when settings are unavailable (SDK/test embedding without `Settings.init()`). */
function readPersistedChannel(): UpdateChannel | undefined {
	try {
		return cfgUpdateChannel.get(settings);
	} catch {
		return undefined;
	}
}

/** Persist an explicit channel switch; tolerated as a no-op when settings are unavailable. */
function persistChannel(channel: UpdateChannel): void {
	try {
		cfgUpdateChannel.set(settings, channel);
	} catch {
		// Outside a CLI host the explicit flag still applied for this run.
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: {
	force: boolean;
	check: boolean;
	channel?: UpdateChannel;
}): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));
	const persistedChannel = readPersistedChannel() ?? "stable";
	const channel = opts.channel ?? persistedChannel;
	const isChannelSwitch = opts.channel !== undefined && opts.channel !== persistedChannel;
	if (channel === "canary") console.log(chalk.dim("Current channel: canary"));

	let release: ReleaseInfo;
	try {
		release = await getLatestRelease({ channel });
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const offeredVersion = release.version;
	const comparison = compareVersions(offeredVersion, VERSION);

	if (comparison <= 0 && !opts.force && !isChannelSwitch) {
		const icon = theme?.status?.success ?? "✔";
		console.log(chalk.green(`${icon} Already up to date`));
		return;
	}

	if (isChannelSwitch) {
		console.log(
			chalk.yellow(
				`Switching to ${channel} ${offeredVersion}${comparison <= 0 ? ` (downgrade from ${VERSION})` : ""}`,
			),
		);
	} else if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${offeredVersion}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${offeredVersion}`));
	}

	if (opts.check) {
		return;
	}

	try {
		const allowPrerelease = channel === "canary";
		const target = await resolveUpdateTarget();
		if (target.method === "brew") {
			console.log(
				chalk.yellow("This installation is managed by Homebrew, but Mars is not distributed through Homebrew."),
			);
			console.log(chalk.dim(homebrewUpdateRefusal()));
			return;
		}
		if (channel === "canary" && (target.method === "nix" || target.method === "mise")) {
			console.log(chalk.yellow("Canary updates are only supported for binary installs."));
			return;
		}
		if (target.method === "nix") {
			console.log(chalk.yellow("This installation is managed by Nix and cannot update itself."));
			console.log(chalk.dim("Update the flake input or profile that provides Mars, then rebuild."));
			return;
		} else if (target.method === "mise") {
			await updateViaMise(offeredVersion, opts.force);
		} else if (target.method === "shim") {
			console.log(chalk.dim("Replacing legacy script launcher with the standalone binary."));
			await updateViaShimTakeover(target.path, offeredVersion, { allowPrerelease });
			console.log(
				chalk.yellow(
					`This install now uses the standalone binary. Removing any old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
				),
			);
		} else {
			if (target.replacesSymlink) {
				console.log(chalk.dim("Replacing legacy package-manager launcher with the standalone binary."));
			}
			await updateViaBinaryAt(target.path, offeredVersion, {
				allowPrerelease,
				validateExistingTarget: target.validateExistingTarget,
			});
			if (target.replacesSymlink) {
				console.log(
					chalk.yellow(
						`This install now uses the standalone binary. Removing any old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
					),
				);
			}
		}
		if (opts.channel) persistChannel(channel);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins
  --canary        Switch to the canary channel and update
  --stable        Switch back to the stable channel

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
  ${APP_NAME} update --canary     Switch to the canary channel and update
`);
}
