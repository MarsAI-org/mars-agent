import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEnabledPlugins } from "@marsai-org/coding-agent/extensibility/plugins/loader";
import {
	LEGACY_PLUGINS_LOCKFILE_NAME,
	PLUGINS_LOCKFILE_NAME,
	legacyPluginsLockfilePath,
	migrateLegacyPluginsLockfile,
	pluginsLockfilePath,
} from "@marsai-org/coding-agent/extensibility/plugins/runtime-config";
import { removeWithRetries } from "@marsai-org/utils";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function tempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("plugin lock file naming", () => {
	test("canonical and legacy names stay distinct", () => {
		expect(PLUGINS_LOCKFILE_NAME).toBe("mars-plugins.lock.json");
		expect(LEGACY_PLUGINS_LOCKFILE_NAME).toBe("omp-plugins.lock.json");
		expect(pluginsLockfilePath("/root")).toBe(path.join("/root", "mars-plugins.lock.json"));
		expect(legacyPluginsLockfilePath("/root")).toBe(path.join("/root", "omp-plugins.lock.json"));
	});

	test("migrates a legacy lock file once and leaves a single lock file behind", async () => {
		const root = await tempRoot("mars-plugin-lock-migrate-");
		const legacy = legacyPluginsLockfilePath(root);
		const canonical = pluginsLockfilePath(root);
		await writeJson(legacy, { plugins: { "legacy-plugin": { version: "1.0.0", enabled: true } }, settings: {} });

		await expect(migrateLegacyPluginsLockfile(root)).resolves.toBe(canonical);
		expect(await exists(canonical)).toBe(true);
		expect(await exists(legacy)).toBe(false);
		expect((await Bun.file(canonical).json()).plugins["legacy-plugin"].version).toBe("1.0.0");

		// Idempotent: a second call keeps the migrated file untouched.
		await expect(migrateLegacyPluginsLockfile(root)).resolves.toBe(canonical);
	});

	test("keeps the canonical lock file when both names exist and reports the stale legacy one", async () => {
		const root = await tempRoot("mars-plugin-lock-both-");
		const legacy = legacyPluginsLockfilePath(root);
		const canonical = pluginsLockfilePath(root);
		await writeJson(legacy, { plugins: { legacy: { version: "0.1.0", enabled: true } }, settings: {} });
		await writeJson(canonical, { plugins: { canonical: { version: "2.0.0", enabled: true } }, settings: {} });

		await expect(migrateLegacyPluginsLockfile(root)).resolves.toBe(canonical);
		// The canonical file wins; the legacy file is neither merged nor deleted.
		expect((await Bun.file(canonical).json()).plugins.canonical.version).toBe("2.0.0");
		expect(await exists(legacy)).toBe(true);
	});

	test("returns the canonical path when neither file exists", async () => {
		const root = await tempRoot("mars-plugin-lock-empty-");
		await expect(migrateLegacyPluginsLockfile(root)).resolves.toBe(pluginsLockfilePath(root));
	});
});

describe("plugin lock file migration through the loader", () => {
	test("reads a legacy lock file and migrates it before loading plugins", async () => {
		const root = await tempRoot("mars-plugin-lock-loader-");
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const pluginsDir = path.join(home, ".mars", "plugins");
		await fs.mkdir(cwd, { recursive: true });

		const pluginDir = path.join(pluginsDir, "node_modules", "legacy-lock-plugin");
		await writeJson(path.join(pluginDir, "package.json"), {
			name: "legacy-lock-plugin",
			version: "1.0.0",
			omp: { extensions: ["ext.ts"] },
		});
		await writeJson(path.join(pluginsDir, "package.json"), {
			name: "mars-plugins",
			private: true,
			dependencies: { "legacy-lock-plugin": "1.0.0" },
		});
		// Pre-rebrand state: only the legacy lock file exists.
		await writeJson(legacyPluginsLockfilePath(pluginsDir), {
			plugins: { "legacy-lock-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		});

		const plugins = await getEnabledPlugins(cwd, { home });

		expect(plugins.map(plugin => plugin.name)).toEqual(["legacy-lock-plugin"]);
		expect(await exists(pluginsLockfilePath(pluginsDir))).toBe(true);
		expect(await exists(legacyPluginsLockfilePath(pluginsDir))).toBe(false);
	});

	test("prefers the canonical lock file when both exist", async () => {
		const root = await tempRoot("mars-plugin-lock-loader-both-");
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const pluginsDir = path.join(home, ".mars", "plugins");
		await fs.mkdir(cwd, { recursive: true });

		const pluginDir = path.join(pluginsDir, "node_modules", "canonical-lock-plugin");
		await writeJson(path.join(pluginDir, "package.json"), {
			name: "canonical-lock-plugin",
			version: "2.0.0",
			omp: { extensions: ["ext.ts"] },
		});
		await writeJson(path.join(pluginsDir, "package.json"), {
			name: "mars-plugins",
			private: true,
			dependencies: { "canonical-lock-plugin": "2.0.0" },
		});
		await writeJson(legacyPluginsLockfilePath(pluginsDir), {
			plugins: { "canonical-lock-plugin": { version: "2.0.0", enabled: false, enabledFeatures: null } },
			settings: {},
		});
		await writeJson(pluginsLockfilePath(pluginsDir), {
			plugins: { "canonical-lock-plugin": { version: "2.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		});

		const plugins = await getEnabledPlugins(cwd, { home });

		// The canonical file says enabled; the stale legacy file says disabled.
		expect(plugins.map(plugin => plugin.name)).toEqual(["canonical-lock-plugin"]);
	});
});
