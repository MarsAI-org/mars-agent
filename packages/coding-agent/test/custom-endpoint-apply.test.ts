import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyCustomEndpointResult } from "@marsai-org/coding-agent/modes/custom-endpoint-apply";
import { cfgProvidersEndpoints } from "@marsai-org/coding-agent/config/provider-endpoint-settings";
import { cfgProvidersContextWindows } from "@marsai-org/coding-agent/config/provider-context-window-settings";
import { TempDir, setAgentDir } from "@marsai-org/utils";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";

let tempDir: TempDir;
let settings: Settings;
let authStorage: { credentials: { set: (provider: string, credential: unknown) => Promise<void> } };
let refresh: ReturnType<typeof vi.fn>;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	resetSettingsForTest();
	tempDir = TempDir.createSync("@mars-custom-endpoint-apply-");
	setAgentDir(tempDir.path());
	settings = Settings.isolated();
	authStorage = { credentials: { set: vi.fn(async () => {}) } };
	refresh = vi.fn(async () => {});
});

afterEach(async () => {
	resetSettingsForTest();
	if (originalAgentDir) process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
	await tempDir.remove().catch(() => {});
});

const targets = () => ({
	settings,
	authStorage: authStorage as unknown as Parameters<typeof applyCustomEndpointResult>[1]["authStorage"],
	modelRegistry: { refresh } as unknown as Parameters<typeof applyCustomEndpointResult>[1]["modelRegistry"],
});

describe("applyCustomEndpointResult", () => {
	it("stores an override under providers.endpoints and refreshes", async () => {
		const message = await applyCustomEndpointResult(
			{ kind: "override", provider: "openai", baseUrl: "https://proxy.example.com/v1" },
			targets(),
		);

		expect(cfgProvidersEndpoints.get(settings)).toEqual({ openai: "https://proxy.example.com/v1" });
		expect(refresh).toHaveBeenCalledWith("online");
		expect(message).toContain("openai");
		// No models.yml is written for an override.
		expect(fs.existsSync(path.join(tempDir.path(), "models.yml"))).toBe(false);
	});

	it("stores an override's context window provider-wide", async () => {
		const message = await applyCustomEndpointResult(
			{ kind: "override", provider: "openai", baseUrl: "https://proxy.example.com/v1", maxContext: 300000 },
			targets(),
		);

		expect(cfgProvidersContextWindows.get(settings)).toEqual({ openai: 300000 });
		expect(message).toContain("300000");
		expect(fs.existsSync(path.join(tempDir.path(), "models.yml"))).toBe(false);
	});

	it("keeps a sibling provider's window when the field is blank", async () => {
		cfgProvidersContextWindows.set(settings, { openai: 128000 });
		await applyCustomEndpointResult(
			{ kind: "override", provider: "anthropic", baseUrl: "https://b.example.com" },
			targets(),
		);

		expect(cfgProvidersContextWindows.get(settings)).toEqual({ openai: 128000 });
	});

	it("keeps sibling endpoints when adding another", async () => {
		await applyCustomEndpointResult(
			{ kind: "override", provider: "openai", baseUrl: "https://a.example.com/v1" },
			targets(),
		);
		await applyCustomEndpointResult(
			{ kind: "override", provider: "anthropic", baseUrl: "https://b.example.com" },
			targets(),
		);

		expect(cfgProvidersEndpoints.get(settings)).toEqual({
			openai: "https://a.example.com/v1",
			anthropic: "https://b.example.com",
		});
	});

	it("installs a supplied credential for the overridden provider", async () => {
		await applyCustomEndpointResult(
			{ kind: "override", provider: "openai", baseUrl: "https://proxy.example.com/v1", apiKey: "  sk-1  " },
			targets(),
		);

		expect(authStorage.credentials.set).toHaveBeenCalledWith("openai", { type: "api_key", key: "sk-1" });
	});

	it("writes a custom provider block to models.yml", async () => {
		const message = await applyCustomEndpointResult(
			{
				kind: "custom",
				provider: "acme",
				baseUrl: "https://acme.example.com/v1",
				api: "openai-completions",
				apiKey: "ACME_KEY",
			},
			targets(),
		);

		const written = fs.readFileSync(path.join(tempDir.path(), "models.yml"), "utf-8");
		expect(written).toContain("acme:");
		expect(written).toContain("https://acme.example.com/v1");
		expect(refresh).toHaveBeenCalledWith("online");
		expect(message).toContain("acme");
	});

	it("writes a declared model's context window into models.yml", async () => {
		await applyCustomEndpointResult(
			{
				kind: "custom",
				provider: "acme",
				baseUrl: "https://acme.example.com/v1",
				api: "openai-completions",
				models: ["chat-v1"],
				maxContext: 64000,
			},
			targets(),
		);

		const written = fs.readFileSync(path.join(tempDir.path(), "models.yml"), "utf-8");
		expect(written).toContain("contextWindow: 64000");
		// The catalog is declared, so nothing is duplicated in settings.
		expect(cfgProvidersContextWindows.get(settings)).toEqual({});
	});

	it("keeps a discovered catalog's window in settings", async () => {
		await applyCustomEndpointResult(
			{
				kind: "custom",
				provider: "acme",
				baseUrl: "https://acme.example.com/v1",
				api: "openai-completions",
				maxContext: 200000,
			},
			targets(),
		);

		expect(cfgProvidersContextWindows.get(settings)).toEqual({ acme: 200000 });
		expect(fs.readFileSync(path.join(tempDir.path(), "models.yml"), "utf-8")).not.toContain("contextWindow");
	});

	it("propagates a validation failure", async () => {
		await expect(
			applyCustomEndpointResult(
				{ kind: "custom", provider: "acme", baseUrl: "not-a-url", api: "openai-completions" },
				targets(),
			),
		).rejects.toThrow();
		expect(refresh).not.toHaveBeenCalled();
	});
});
