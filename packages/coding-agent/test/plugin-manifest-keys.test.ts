import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@marsai-org/coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@marsai-org/coding-agent/extensibility/plugins/loader";
import { resolvePluginManifest } from "@marsai-org/coding-agent/extensibility/plugins/types";
import { removeWithRetries } from "@marsai-org/utils";

const tempRoots: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

describe("plugin manifest key resolution", () => {
	test("prefers the canonical mars key", () => {
		const manifest = resolvePluginManifest({
			mars: { version: "2.0.0", extensions: ["./mars.ts"] },
			omp: { version: "1.0.0", extensions: ["./omp.ts"] },
			pi: { version: "0.1.0", extensions: ["./pi.ts"] },
		});
		expect(manifest?.extensions).toEqual(["./mars.ts"]);
	});

	test("falls back to the pre-rebrand omp key", () => {
		const manifest = resolvePluginManifest({
			omp: { version: "1.0.0", extensions: ["./omp.ts"] },
			pi: { version: "0.1.0", extensions: ["./pi.ts"] },
		});
		expect(manifest?.extensions).toEqual(["./omp.ts"]);
	});

	test("falls back to the original pi key", () => {
		expect(resolvePluginManifest({ pi: { version: "0.1.0", extensions: ["./pi.ts"] } })?.extensions).toEqual([
			"./pi.ts",
		]);
	});

	test("returns undefined when no manifest key is present", () => {
		expect(resolvePluginManifest({})).toBeUndefined();
	});
});

describe("plugin loader manifest keys", () => {
	async function plantPlugin(manifestKey: "mars" | "omp" | "pi"): Promise<{ home: string; cwd: string }> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `mars-plugin-${manifestKey}-key-`));
		tempRoots.push(root);
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const pluginsDir = path.join(home, ".mars", "plugins");
		await fs.mkdir(cwd, { recursive: true });

		const pluginName = `${manifestKey}-key-plugin`;
		await writeJson(path.join(pluginsDir, "node_modules", pluginName, "package.json"), {
			name: pluginName,
			version: "1.0.0",
			[manifestKey]: { extensions: ["ext.ts"] },
		});
		await writeJson(path.join(pluginsDir, "package.json"), {
			name: "mars-plugins",
			private: true,
			dependencies: { [pluginName]: "1.0.0" },
		});
		await writeJson(path.join(pluginsDir, "mars-plugins.lock.json"), {
			plugins: { [pluginName]: { version: "1.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		});
		return { home, cwd };
	}

	test("loads a plugin that declares the canonical mars key", async () => {
		const { home, cwd } = await plantPlugin("mars");
		const plugins = await getEnabledPlugins(cwd, { home });
		expect(plugins.map(plugin => plugin.name)).toEqual(["mars-key-plugin"]);
	});

	test("loads an installed plugin that still declares only the legacy omp key", async () => {
		const { home, cwd } = await plantPlugin("omp");
		const plugins = await getEnabledPlugins(cwd, { home });
		expect(plugins.map(plugin => plugin.name)).toEqual(["omp-key-plugin"]);
	});

	test("loads a plugin that still declares only the original pi key", async () => {
		const { home, cwd } = await plantPlugin("pi");
		const plugins = await getEnabledPlugins(cwd, { home });
		expect(plugins.map(plugin => plugin.name)).toEqual(["pi-key-plugin"]);
	});
});
