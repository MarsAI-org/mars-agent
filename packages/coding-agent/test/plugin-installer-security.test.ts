import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installPlugin, linkPlugin, uninstallPlugin } from "@marsai-org/coding-agent/extensibility/plugins/installer";
import { PluginManager } from "@marsai-org/coding-agent/extensibility/plugins/manager";
import * as piUtils from "@marsai-org/utils";
import { removeWithRetries } from "@marsai-org/utils";
import type { Subprocess } from "bun";

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) throw new Error("Failed to create empty response stream");
	return body;
}

describe("plugin installer & manager security guards", () => {
	let tmpRoot: string;
	let projectDir: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mars-plugin-sec-"));
		projectDir = path.join(tmpRoot, "project");
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "mars-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(projectDir);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	test("linkPlugin rejects scoped traversal package names without deleting parent directories", async () => {
		const sentinel = path.join(pluginsDir, "sentinel.txt");
		await Bun.write(sentinel, "do-not-delete");

		for (const maliciousName of ["@../..", "@a/b\\..\\..\\..", "@scope/..", "../../escape", "-flag-pkg"]) {
			const pluginDir = path.join(projectDir, "bad-plugin");
			await fs.rm(pluginDir, { recursive: true, force: true });
			await fs.mkdir(pluginDir, { recursive: true });
			await Bun.write(
				path.join(pluginDir, "package.json"),
				JSON.stringify({ name: maliciousName, version: "1.0.0" }),
			);

			await expect(linkPlugin("bad-plugin")).rejects.toThrow(/Invalid package name/);
			expect(await Bun.file(sentinel).text()).toBe("do-not-delete");
		}
	});

	test("linkPlugin rejects a symlink inside cwd that resolves outside cwd", async () => {
		const outsideDir = path.join(tmpRoot, "outside-plugin");
		await fs.mkdir(outsideDir, { recursive: true });
		await Bun.write(
			path.join(outsideDir, "package.json"),
			JSON.stringify({ name: "escaped-plugin", version: "1.0.0" }),
		);

		const symlinkPath = path.join(projectDir, "sneaky-link");
		await fs.symlink(outsideDir, symlinkPath, process.platform === "win32" ? "junction" : "dir");

		await expect(linkPlugin("sneaky-link")).rejects.toThrow(/resolves outside working directory/);
	});

	test("linkPlugin links a valid scoped plugin inside cwd", async () => {
		const pluginDir = path.join(projectDir, "good-plugin");
		await fs.mkdir(pluginDir, { recursive: true });
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "@acme/good-plugin", version: "1.0.0" }),
		);

		await linkPlugin("good-plugin");

		const linkPath = path.join(pluginsNodeModules, "@acme", "good-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(linkPath)).toBe(await fs.realpath(pluginDir));
	});

	test("rejects leading-dash CLI flags across installer and PluginManager", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const manager = new PluginManager(projectDir);

		for (const flagSpec of ["-g", "--global", "--ignore-scripts", "@-scope/pkg", "@scope/-pkg"]) {
			await expect(installPlugin(flagSpec)).rejects.toThrow(/Invalid package name/);
			await expect(uninstallPlugin(flagSpec)).rejects.toThrow(/Invalid package name/);
			await expect(manager.install(flagSpec)).rejects.toThrow(/Invalid package name/);
			await expect(manager.uninstall(flagSpec)).rejects.toThrow(/Invalid package name/);
		}
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	test("passes `--` option terminator to bun install and bun uninstall", async () => {
		const commands: string[][] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			commands.push([...cmd]);
			const prepare =
				cmd[1] === "install"
					? (async () => {
							const installed = path.join(pluginsNodeModules, "demo-plugin");
							await fs.mkdir(installed, { recursive: true });
							await Bun.write(
								path.join(installed, "package.json"),
								JSON.stringify({ name: "demo-plugin", version: "1.0.0" }),
							);
						})()
					: Promise.resolve();
			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await installPlugin("demo-plugin");
		await uninstallPlugin("demo-plugin");
		await new PluginManager(projectDir).uninstall("demo-plugin");

		expect(commands).toEqual([
			["bun", "install", "--", "demo-plugin"],
			["bun", "uninstall", "--", "demo-plugin"],
			["bun", "uninstall", "--", "demo-plugin"],
		]);
	});
});
