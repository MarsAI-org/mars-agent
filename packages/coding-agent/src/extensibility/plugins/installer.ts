import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPluginsDir, getPluginsNodeModules, getProjectDir } from "@marsai-org/utils";
import { extractPackageName } from "./parser";
import { type InstalledPlugin, resolvePluginManifest } from "./types";

// Valid npm package name pattern (scoped and unscoped, optional version specifier).
// Disallows leading `-` (CLI flag injection) and leading `.`/`_` (path traversal).
const VALID_PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*(@[a-z0-9._^~>=<-]+)?$/i;
// Exact npm package name without version specifier (used for package.json `name` in linkPlugin).
const VALID_EXACT_PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;

/**
 * Validate package name to prevent command and flag injection.
 */
function validatePackageName(name: string): void {
	if (name.startsWith("-") || name.includes("..") || !VALID_PACKAGE_NAME.test(name)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

/**
 * Ensure the plugins directory exists
 */
async function ensurePluginsDir(): Promise<void> {
	await fs.mkdir(getPluginsDir(), { recursive: true });
	await fs.mkdir(getPluginsNodeModules(), { recursive: true });
}

export async function installPlugin(packageName: string): Promise<InstalledPlugin> {
	// Validate package name to prevent command injection
	validatePackageName(packageName);

	// Ensure plugins directory exists
	await ensurePluginsDir();
	const pluginsDir = getPluginsDir();
	const pluginsNodeModules = getPluginsNodeModules();

	// Initialize package.json if it doesn't exist
	const pkgJsonPath = path.join(pluginsDir, "package.json");
	const pkgJson = Bun.file(pkgJsonPath);
	if (!(await pkgJson.exists())) {
		await pkgJson.write(JSON.stringify({ name: "mars-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run bun install in plugins directory (`--` prevents flag injection)
	const proc = Bun.spawn(["bun", "install", "--", packageName], {
		cwd: pluginsDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	// Drain both pipes concurrently with proc.exited to avoid a pipe-buffer
	// deadlock if bun install floods stdout/stderr.
	const [exitCode, , stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	const actualName = extractPackageName(packageName);

	// Read the installed package's package.json
	const pkgPath = path.join(pluginsNodeModules, actualName, "package.json");
	const pkgFile = Bun.file(pkgPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = await pkgFile.json();

	return {
		name: pkg.name,
		version: pkg.version,
		path: path.join(pluginsNodeModules, actualName),
		manifest: resolvePluginManifest(pkg) ?? { version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
}

export async function uninstallPlugin(name: string): Promise<void> {
	// Validate package name
	validatePackageName(name);

	await ensurePluginsDir();

	const proc = Bun.spawn(["bun", "uninstall", "--", name], {
		cwd: getPluginsDir(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const [exitCode] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pluginsDir = getPluginsDir();
	const pluginsNodeModules = getPluginsNodeModules();
	const pkgJsonPath = Bun.file(path.join(pluginsDir, "package.json"));
	if (!(await pkgJsonPath.exists())) {
		return [];
	}

	const pkg = await pkgJsonPath.json();
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPath = path.join(pluginsNodeModules, name);
		const fpkg = Bun.file(path.join(pluginPath, "package.json"));
		if (await fpkg.exists()) {
			const pkg = await fpkg.json();
			plugins.push({
				name,
				version: pkg.version,
				path: pluginPath,
				manifest: resolvePluginManifest(pkg) ?? { version: pkg.version },
				enabledFeatures: null,
				enabled: true,
			});
		}
	}

	return plugins;
}

export async function linkPlugin(localPath: string): Promise<void> {
	const cwd = getProjectDir();
	const normalizedCwd = path.resolve(cwd);
	const absolutePath = path.resolve(cwd, localPath);

	// Validate that resolved path is within cwd to prevent path traversal
	const normalizedCwdPrefix = normalizedCwd.endsWith(path.sep) ? normalizedCwd : `${normalizedCwd}${path.sep}`;
	if (absolutePath !== normalizedCwd && !absolutePath.startsWith(normalizedCwdPrefix)) {
		throw new Error(`Invalid path: ${localPath} resolves outside working directory`);
	}

	// Validate package.json exists before realpath so missing paths report the expected error
	const pkgFile = Bun.file(path.join(absolutePath, "package.json"));
	if (!(await pkgFile.exists())) {
		throw new Error(`package.json not found at ${absolutePath}`);
	}

	// Re-check containment after resolving symlinks so a symlink inside cwd cannot escape it
	const [realCwd, realTarget] = await Promise.all([fs.realpath(normalizedCwd), fs.realpath(absolutePath)]);
	const realCwdPrefix = realCwd.endsWith(path.sep) ? realCwd : `${realCwd}${path.sep}`;
	if (realTarget !== realCwd && !realTarget.startsWith(realCwdPrefix)) {
		throw new Error(`Invalid path: ${localPath} resolves outside working directory`);
	}

	let pkg: { name?: string };
	try {
		pkg = await Bun.file(path.join(realTarget, "package.json")).json();
	} catch (err) {
		throw new Error(`Invalid package.json at ${absolutePath}: ${err}`);
	}

	if (!pkg.name || typeof pkg.name !== "string") {
		throw new Error("package.json must have a valid name field");
	}

	// Enforce a strict npm package name (no `..`, no `\`, no leading `-`) to prevent path traversal
	if (
		!VALID_EXACT_PACKAGE_NAME.test(pkg.name) ||
		pkg.name.includes("..") ||
		pkg.name.includes("\\") ||
		pkg.name.startsWith("-")
	) {
		throw new Error(`Invalid package name in package.json: ${pkg.name}`);
	}

	await ensurePluginsDir();

	// Resolve and verify containment inside plugins/node_modules before any filesystem mutation
	const nodeModulesDir = path.resolve(getPluginsNodeModules());
	const nodeModulesPrefix = nodeModulesDir.endsWith(path.sep) ? nodeModulesDir : `${nodeModulesDir}${path.sep}`;
	const linkPath = path.resolve(nodeModulesDir, pkg.name);
	if (!linkPath.startsWith(nodeModulesPrefix)) {
		throw new Error(`Invalid package name in package.json: ${pkg.name}`);
	}

	// For scoped packages, ensure the scope directory exists and stays inside node_modules
	if (pkg.name.startsWith("@")) {
		const scopeDir = path.resolve(nodeModulesDir, pkg.name.split("/")[0]);
		if (!scopeDir.startsWith(nodeModulesPrefix)) {
			throw new Error(`Invalid package name in package.json: ${pkg.name}`);
		}
		await fs.mkdir(scopeDir, { recursive: true });
	}

	// Whatever is there — a stale link, or a real directory from a git install.
	await fs.rm(linkPath, { recursive: true, force: true });

	// Junction on Windows: a plain directory symlink EPERMs outside developer mode.
	await fs.symlink(realTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
}
