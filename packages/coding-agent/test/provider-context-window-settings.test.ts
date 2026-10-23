import { describe, expect, test } from "bun:test";
import {
	cfgProvidersContextWindows,
	normalizeProviderContextWindows,
	validateProviderContextWindows,
} from "@marsai-org/coding-agent/config/provider-context-window-settings";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";

describe("provider-context-window-settings", () => {
	test("normalizes empty or invalid non-record inputs to empty record", () => {
		expect(normalizeProviderContextWindows(null)).toEqual({});
		expect(normalizeProviderContextWindows(undefined)).toEqual({});
		expect(normalizeProviderContextWindows("not-a-record")).toEqual({});
		expect(normalizeProviderContextWindows([])).toEqual({});
	});

	test("coerces numeric text, dropping non-positive, fractional, and non-numeric entries", () => {
		const raw = {
			openai: 200000,
			anthropic: 0,
			google: -5,
			acme: 12.5,
			other: "32000",
			general: 64000,
			quoted: " 1000 ",
			empty: "",
			word: "lots",
		};
		expect(normalizeProviderContextWindows(raw)).toEqual({
			openai: 200000,
			other: 32000,
			general: 64000,
			quoted: 1000,
		});
	});

	test("keeps valid entries as-is", () => {
		const valid = { openai: 200000, anthropic: 1000000 };
		expect(validateProviderContextWindows(valid)).toEqual(valid);
		expect(normalizeProviderContextWindows(valid)).toEqual(valid);
	});

	test("rejects invalid values naming the provider", () => {
		expect(() => validateProviderContextWindows({ openai: 0 })).toThrow("openai");
		expect(() => validateProviderContextWindows({ anthropic: -1 })).toThrow("positive integers");
		expect(() => validateProviderContextWindows({ google: 1.5 })).toThrow("positive integers");
	});

	test("integrates with Settings.isolated", () => {
		resetSettingsForTest();
		const s = Settings.isolated({ "providers.contextWindows": { openai: 200000 } });

		expect(cfgProvidersContextWindows.get(s)).toEqual({ openai: 200000 });
	});
});
