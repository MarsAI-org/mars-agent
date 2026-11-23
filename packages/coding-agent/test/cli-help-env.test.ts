import { describe, expect, it } from "bun:test";
import { syncWalkWorkersEnv } from "@marsai-org/coding-agent/cli/grep-cli";
import { getExtraHelpText } from "@marsai-org/coding-agent/cli/help-extra";

const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

describe("--help environment variable section", () => {
	const help = stripAnsi(getExtraHelpText());

	it("documents MARS_* as the canonical names", () => {
		for (const name of [
			"MARS_PROFILE",
			"MARS_CODING_AGENT_DIR",
			"MARS_CONFIG_DIR",
			"MARS_PACKAGE_DIR",
			"MARS_SMOL_MODEL",
			"MARS_SLOW_MODEL",
			"MARS_PLAN_MODEL",
			"MARS_NO_PTY",
		]) {
			expect(help).toContain(name);
		}
	});

	it("does not advertise PI_* as the primary name", () => {
		expect(help).not.toMatch(/^ {2}PI_(?:CODING_AGENT_DIR|PACKAGE_DIR|SMOL_MODEL|SLOW_MODEL|PLAN_MODEL|NO_PTY) /m);
	});

	it("mentions the legacy PI_* names once, as deprecated fallbacks", () => {
		expect(help).toContain("Legacy PI_* names");
		expect(help).toContain("deprecated");
		expect(help.match(/PI_CODING_AGENT_DIR/g)).toHaveLength(1);
	});

	it("aligns every environment variable separator column and links to the hosted docs", () => {
		const envSection = help.slice(0, help.indexOf("Available Tools"));
		const dashColumns = envSection
			.split("\n")
			.filter(line => /^ {2}[A-Z][A-Z0-9_]+ +- /.test(line))
			.map(line => line.indexOf(" - "));
		expect(dashColumns.length).toBeGreaterThan(30);
		expect(new Set(dashColumns).size).toBe(1);
		expect(envSection).toContain("https://github.com/MarsAI-org/mars-agent/blob/main/docs/environment-variables.md");
	});
});

describe("syncWalkWorkersEnv", () => {
	it("propagates MARS_WALK_WORKERS into PI_WALK_WORKERS and prefers MARS over legacy names", () => {
		const env: Record<string, string | undefined> = { MARS_WALK_WORKERS: "2", PI_WALK_WORKERS: "8" };
		expect(syncWalkWorkersEnv(env)).toBe("2");
		expect(env.PI_WALK_WORKERS).toBe("2");
	});

	it("falls back to PI_WALK_WORKERS when MARS_WALK_WORKERS is unset", () => {
		const env: Record<string, string | undefined> = { PI_WALK_WORKERS: "6" };
		expect(syncWalkWorkersEnv(env)).toBe("6");
		expect(env.PI_WALK_WORKERS).toBe("6");
	});
});
