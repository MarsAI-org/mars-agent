import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetLegacyEnvWarningsForTests,
	flagCompatEnv,
	LEGACY_ENV_ALIASES,
	pickCompatEnv,
	readCompatEnv,
	takeLegacyEnvWarnings,
} from "@marsai-org/utils/env-compat";

afterEach(() => {
	__resetLegacyEnvWarningsForTests();
});

describe("readCompatEnv", () => {
	test("prefers the canonical MARS_ name", () => {
		expect(readCompatEnv("MARS_MCP_TIMEOUT_MS", { MARS_MCP_TIMEOUT_MS: "1000", OMP_MCP_TIMEOUT_MS: "2000" })).toBe(
			"1000",
		);
	});

	test("falls back to the legacy OMP_ name and warns once", () => {
		const env = { OMP_MCP_TIMEOUT_MS: "2000" };
		expect(readCompatEnv("MARS_MCP_TIMEOUT_MS", env)).toBe("2000");
		expect(takeLegacyEnvWarnings()).toEqual(["OMP_MCP_TIMEOUT_MS is deprecated; use MARS_MCP_TIMEOUT_MS instead."]);
		// Second read still resolves, but must not queue a second warning.
		expect(readCompatEnv("MARS_MCP_TIMEOUT_MS", env)).toBe("2000");
		expect(takeLegacyEnvWarnings()).toEqual([]);
	});

	test("does not fall back when the canonical name is explicitly empty", () => {
		const env = { MARS_NO_WEBP: "", OMP_NO_WEBP: "1" };
		expect(readCompatEnv("MARS_NO_WEBP", env)).toBe("");
		expect(takeLegacyEnvWarnings()).toEqual([]);
	});

	test("returns undefined for unknown names and absent pairs", () => {
		expect(readCompatEnv("MARS_NOT_AN_ALIAS", { OMP_NOT_AN_ALIAS: "x" })).toBeUndefined();
		expect(readCompatEnv("MARS_MCP_TIMEOUT_MS", {})).toBeUndefined();
	});
});

describe("flagCompatEnv", () => {
	test("accepts legacy truthy spellings", () => {
		expect(flagCompatEnv("MARS_MCP_REQUIRE_READY", false, { OMP_MCP_REQUIRE_READY: "1" })).toBe(true);
		expect(flagCompatEnv("MARS_MCP_REQUIRE_READY", false, { OMP_MCP_REQUIRE_READY: "yes" })).toBe(true);
	});

	test("treats empty as unset and other values as false", () => {
		expect(flagCompatEnv("MARS_MCP_REQUIRE_READY", true, { OMP_MCP_REQUIRE_READY: "" })).toBe(true);
		expect(flagCompatEnv("MARS_MCP_REQUIRE_READY", true, { OMP_MCP_REQUIRE_READY: "0" })).toBe(false);
	});

	test("canonical wins over legacy", () => {
		expect(
			flagCompatEnv("MARS_MCP_REQUIRE_READY", false, {
				MARS_MCP_REQUIRE_READY: "0",
				OMP_MCP_REQUIRE_READY: "1",
			}),
		).toBe(false);
	});
});

describe("pickCompatEnv", () => {
	test("returns the first non-empty trimmed value across names", () => {
		expect(pickCompatEnv(["MARS_MISSING", "MARS_AUTH_BROKER_URL"], { OMP_AUTH_BROKER_URL: "  http://x  " })).toBe(
			"http://x",
		);
	});
});

describe("LEGACY_ENV_ALIASES", () => {
	test("every legacy name keeps the OMP_ prefix", () => {
		for (const [canonical, legacy] of Object.entries(LEGACY_ENV_ALIASES)) {
			expect(canonical.startsWith("MARS_")).toBe(true);
			expect(legacy.startsWith("OMP_")).toBe(true);
			expect(legacy.slice(4)).toBe(canonical.slice(5));
		}
	});
});
