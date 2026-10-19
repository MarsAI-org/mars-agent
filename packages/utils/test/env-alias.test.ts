import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	__resetEnvAliasNoticesForTests,
	__takeEnvAliasNoticesForTests,
	envAliasNotice,
	flushEnvAliasNotices,
	noteInternalEnvWrite,
	resolveEnvAlias,
} from "@marsai-org/utils/env-alias";

describe("resolveEnvAlias", () => {
	beforeEach(() => {
		__resetEnvAliasNoticesForTests();
	});

	afterEach(() => {
		__resetEnvAliasNoticesForTests();
	});

	it("returns the canonical value when both names are set", () => {
		const value = resolveEnvAlias("MARS_SMOL_MODEL", "PI_SMOL_MODEL", {
			env: { MARS_SMOL_MODEL: "new", PI_SMOL_MODEL: "old" },
		});
		expect(value).toBe("new");
		expect(__takeEnvAliasNoticesForTests()).toEqual([]);
	});

	it("falls back to the legacy value and queues one notice", () => {
		const env = { PI_SMOL_MODEL: "old" };
		expect(resolveEnvAlias("MARS_SMOL_MODEL", "PI_SMOL_MODEL", { env })).toBe("old");
		expect(resolveEnvAlias("MARS_SMOL_MODEL", "PI_SMOL_MODEL", { env })).toBe("old");
		expect(__takeEnvAliasNoticesForTests()).toEqual([envAliasNotice("PI_SMOL_MODEL", "MARS_SMOL_MODEL")]);
	});

	it("treats empty and whitespace values as unset", () => {
		expect(resolveEnvAlias("MARS_PACKAGE_DIR", "PI_PACKAGE_DIR", { env: { MARS_PACKAGE_DIR: "  " } })).toBe(
			undefined,
		);
		expect(resolveEnvAlias("MARS_PACKAGE_DIR", "PI_PACKAGE_DIR", { env: { PI_PACKAGE_DIR: "" } })).toBe(undefined);
	});

	it("stays quiet for values Mars wrote itself", () => {
		const env = { PI_CODING_AGENT_DIR: "/tmp/mars-agent" };
		noteInternalEnvWrite("PI_CODING_AGENT_DIR", "/tmp/mars-agent");
		expect(resolveEnvAlias("MARS_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", { env })).toBe("/tmp/mars-agent");
		expect(__takeEnvAliasNoticesForTests()).toEqual([]);
	});

	it("honors the quiet option", () => {
		const value = resolveEnvAlias("MARS_NO_PTY", "PI_NO_PTY", {
			env: { PI_NO_PTY: "1" },
			quiet: true,
		});
		expect(value).toBe("1");
		expect(__takeEnvAliasNoticesForTests()).toEqual([]);
	});

	it("queues one notice per legacy variable, not per lookup site", () => {
		const env = { PI_SMOL_MODEL: "a", PI_SLOW_MODEL: "b" };
		resolveEnvAlias("MARS_SMOL_MODEL", "PI_SMOL_MODEL", { env });
		resolveEnvAlias("MARS_SLOW_MODEL", "PI_SLOW_MODEL", { env });
		resolveEnvAlias("MARS_SMOL_MODEL", "PI_SMOL_MODEL", { env });
		expect(__takeEnvAliasNoticesForTests()).toHaveLength(2);
	});

	it("flushes queued notices through the caller's sink", () => {
		resolveEnvAlias("MARS_PLAN_MODEL", "PI_PLAN_MODEL", { env: { PI_PLAN_MODEL: "p" } });
		const written: string[] = [];
		// Under `bun test` the enabled check is false, so the sink must stay empty.
		expect(flushEnvAliasNotices(text => written.push(text))).toBe(0);
		expect(written).toEqual([]);
		expect(__takeEnvAliasNoticesForTests()).toEqual([]);
	});
});
