import { describe, expect, test } from "bun:test";
import {
	cfgProvidersEndpoints,
	normalizeProviderEndpoints,
	validateProviderEndpoints,
} from "@marsai-org/coding-agent/config/provider-endpoint-settings";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";

describe("provider-endpoint-settings", () => {
	test("normalizes empty or invalid non-record inputs to empty record", () => {
		expect(normalizeProviderEndpoints(null)).toEqual({});
		expect(normalizeProviderEndpoints(undefined)).toEqual({});
		expect(normalizeProviderEndpoints("not-a-record")).toEqual({});
		expect(normalizeProviderEndpoints([])).toEqual({});
	});

	test("normalizes and trims valid endpoints, dropping non-string or empty entries", () => {
		const raw = {
			openai: "  https://api.openai-proxy.com/v1  ",
			anthropic: "https://gateway.example.com",
			empty: "   ",
			invalidType: 12345,
		};
		expect(normalizeProviderEndpoints(raw)).toEqual({
			openai: "https://api.openai-proxy.com/v1",
			anthropic: "https://gateway.example.com",
		});
	});

	test("validates valid absolute HTTP, HTTPS, and local URLs", () => {
		const valid = {
			openai: "https://my-proxy/v1",
			ollama: "http://127.0.0.1:11434",
			apple: "local://apple-foundation-models",
		};
		expect(validateProviderEndpoints(valid)).toEqual(valid);
	});

	test("rejects non-absolute or invalid protocol URLs with descriptive error", () => {
		expect(() =>
			validateProviderEndpoints({
				openai: "bare-host.com/v1",
			}),
		).toThrow("Provider endpoints must be absolute URLs");

		expect(() =>
			validateProviderEndpoints({
				badProtocol: "ftp://files.example.com",
			}),
		).toThrow("Provider endpoints must be absolute URLs");
	});

	test("drops blank entries instead of failing the whole config load", () => {
		// A hand-edited `gw:` parses as null; rejecting it would fail
		// `Settings.init()` and take every command down with it.
		expect(validateProviderEndpoints({ gw: null, ok: "https://gw.example.com/v1" })).toEqual({
			ok: "https://gw.example.com/v1",
		});
		expect(validateProviderEndpoints({ gw: undefined, ok: "https://gw.example.com/v1" })).toEqual({
			ok: "https://gw.example.com/v1",
		});
		expect(validateProviderEndpoints({ gw: "   ", ok: "https://gw.example.com/v1" })).toEqual({
			ok: "https://gw.example.com/v1",
		});
		resetSettingsForTest();
		const s = Settings.isolated({ "providers.endpoints": { gw: null, ok: "https://gw.example.com/v1" } });

		expect(cfgProvidersEndpoints.get(s)).toEqual({ ok: "https://gw.example.com/v1" });
	});

	test("still rejects a non-string endpoint value", () => {
		expect(() => validateProviderEndpoints({ gw: 12345 })).toThrow("gw");
	});

	test("integrates with Settings.isolated", () => {
		resetSettingsForTest();
		const s = Settings.isolated({
			"providers.endpoints": {
				openai: "https://custom-openai.test/v1",
				anthropic: "https://custom-anthropic.test",
			},
		});

		const configured = cfgProvidersEndpoints.get(s);
		expect(configured).toEqual({
			openai: "https://custom-openai.test/v1",
			anthropic: "https://custom-anthropic.test",
		});
	});
});
