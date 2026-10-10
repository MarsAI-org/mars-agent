import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetProfileSnapshotForTests, LEGACY_CONFIG_MIGRATION_NOTICE } from "@marsai-org/utils/dirs";
import { Snowflake } from "@marsai-org/utils/snowflake";

// Module-global "already evaluated" state makes `maybeMigrateLegacyConfigDir`
// fire once per process, so each case needs a fresh copy of the module. Static
// imports cannot express that. `Bun.resolveSync` fixes the specifier so the
// query-string cache-buster below is the only variation.
const DIRS_SPECIFIER = Bun.resolveSync("@marsai-org/utils/dirs", import.meta.path);

const ENV_KEYS = ["MARS_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"] as const;

describe("legacy ~/.omp → ~/.mars migration", () => {
	let tempHome = "";
	let homeSpy: ReturnType<typeof spyOn>;
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	async function freshDirs(): Promise<typeof import("@marsai-org/utils/dirs")> {
		const suffix = `?migration-test=${Snowflake.next()}`;
		return (await import(`${DIRS_SPECIFIER}${suffix}`)) as typeof import("@marsai-org/utils/dirs");
	}

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		delete process.env.MARS_PROFILE;
		delete process.env.PI_PROFILE;
		delete process.env.PI_CONFIG_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		tempHome = path.join(os.tmpdir(), "pi-utils-dirs-migration", Snowflake.next());
		await fs.promises.mkdir(tempHome, { recursive: true });
		// `os` is a namespace import in dirs.ts, so spying on `homedir` redirects
		// every home-derived path inside the freshly imported copy.
		homeSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
		__resetProfileSnapshotForTests();
	});

	afterEach(async () => {
		homeSpy.mockRestore();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetProfileSnapshotForTests();
		await fs.promises.rm(tempHome, { recursive: true, force: true });
	});

	async function seedLegacy(): Promise<void> {
		const legacyAgent = path.join(tempHome, ".omp", "agent");
		await fs.promises.mkdir(legacyAgent, { recursive: true });
		await Bun.write(path.join(legacyAgent, "config.yml"), "theme: dark\n");
		await Bun.write(path.join(tempHome, ".omp", "install-id"), "00000000-0000-4000-8000-000000000000\n");
	}

	async function listLegacy(): Promise<string[]> {
		const walk = async (dir: string, prefix: string): Promise<string[]> => {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			const out: string[] = [];
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
				else out.push(rel);
			}
			return out.sort();
		};
		return walk(path.join(tempHome, ".omp"), "");
	}

	it("copies the old tree to the new root and reports the notice once", async () => {
		await seedLegacy();
		const dirs = await freshDirs();

		expect(dirs.maybeMigrateLegacyConfigDir()).toBe(true);
		expect(await Bun.file(path.join(tempHome, ".mars", "agent", "config.yml")).text()).toBe("theme: dark\n");
		expect(await Bun.file(path.join(tempHome, ".mars", "install-id")).text()).toBe(
			"00000000-0000-4000-8000-000000000000\n",
		);
		expect(dirs.takeLegacyConfigMigrationNotice()).toBe(LEGACY_CONFIG_MIGRATION_NOTICE);
		// Drained: further consumers in the same process get nothing.
		expect(dirs.takeLegacyConfigMigrationNotice()).toBeUndefined();
		// The legacy tree survives byte-for-byte: a copy, never a move.
		expect(await listLegacy()).toEqual(await listLegacy());
		expect(fs.existsSync(path.join(tempHome, ".omp", "agent", "config.yml"))).toBe(true);
	});

	it("leaves an existing new root alone and reports nothing", async () => {
		await seedLegacy();
		const fresh = path.join(tempHome, ".mars", "agent");
		await fs.promises.mkdir(fresh, { recursive: true });
		await Bun.write(path.join(fresh, "config.yml"), "theme: light\n");
		const dirs = await freshDirs();

		expect(dirs.maybeMigrateLegacyConfigDir()).toBe(false);
		// The user's new-root content wins; the old tree is never merged over it.
		expect(await Bun.file(path.join(tempHome, ".mars", "agent", "config.yml")).text()).toBe("theme: light\n");
		expect(dirs.takeLegacyConfigMigrationNotice()).toBeUndefined();
	});

	it("creates nothing and reports nothing when neither root exists", async () => {
		const dirs = await freshDirs();

		expect(dirs.maybeMigrateLegacyConfigDir()).toBe(false);
		expect(fs.existsSync(path.join(tempHome, ".mars"))).toBe(false);
		expect(dirs.takeLegacyConfigMigrationNotice()).toBeUndefined();
	});

	it("stays out of the way when PI_CONFIG_DIR overrides the root", async () => {
		await seedLegacy();
		process.env.PI_CONFIG_DIR = path.join(tempHome, "custom-root");
		const dirs = await freshDirs();

		expect(dirs.maybeMigrateLegacyConfigDir()).toBe(false);
		expect(fs.existsSync(path.join(tempHome, ".mars"))).toBe(false);
		expect(dirs.takeLegacyConfigMigrationNotice()).toBeUndefined();
	});
});
