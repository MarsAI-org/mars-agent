import { describe, expect, it } from "bun:test";
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
});
