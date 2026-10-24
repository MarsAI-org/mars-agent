import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@marsai-org/agent-core";
import { ModelRegistry } from "@marsai-org/coding-agent/config/model-registry";
import { cfgProvidersContextWindows } from "@marsai-org/coding-agent/config/provider-context-window-settings";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import { AgentSession } from "@marsai-org/coding-agent/session/agent-session";
import { AuthStorage } from "@marsai-org/coding-agent/session/auth-storage";
import { SessionManager } from "@marsai-org/coding-agent/session/session-manager";
import { TempDir } from "@marsai-org/utils";

let tempDir: TempDir;
let modelsPath: string;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = TempDir.createSync("@mars-context-window-");
	modelsPath = path.join(tempDir.path(), "models.yml");
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage.close();
	resetSettingsForTest();
	vi.restoreAllMocks();
	await tempDir.remove().catch(() => {});
});

/** A registry over an explicit models.yml path, with the given settings layers. */
function registryWith(settings: Settings): ModelRegistry {
	return new ModelRegistry(authStorage, modelsPath, {
		settings,
		cacheDbPath: path.join(tempDir.path(), "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in this test")),
	});
}

describe("providers.contextWindows", () => {
	test("replaces a built-in provider's advertised window", () => {
		const bundled = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(tempDir.path(), "models.db"),
			fetch: () => Promise.reject(new Error("network disabled in this test")),
		}).find("openai", "gpt-5.4");
		expect(bundled?.contextWindow).not.toBe(123456);

		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { openai: 123456 } }));

		expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(123456);
	});

	test("leaves other providers alone", () => {
		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { openai: 123456 } }));

		expect(registry.find("anthropic", "claude-opus-4-8")?.contextWindow).not.toBe(123456);
	});

	test("a models.yml contextWindow for the same model wins", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  openai:",
				"    baseUrl: https://proxy.example.com/v1",
				"    api: openai-completions",
				"    apiKey: TEST_KEY",
				"    models:",
				"      - id: gpt-5.4",
				"        contextWindow: 64000",
				"",
			].join("\n"),
		);
		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { openai: 123456 } }));

		expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(64000);
	});

	test("a modelOverrides contextWindow wins", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  openai:",
				"    baseUrl: https://proxy.example.com/v1",
				"    api: openai-completions",
				"    apiKey: TEST_KEY",
				"    modelOverrides:",
				"      gpt-5.4:",
				"        contextWindow: 64000",
				"",
			].join("\n"),
		);
		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { openai: 123456 } }));

		expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(64000);
	});

	test("skips kinds that carry no prompt", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example.com/v1",
				"    apiKey: ACME_KEY",
				"    api: openai-responses",
				"    models:",
				"      - id: acme-draw",
				"        kind: image",
				"",
			].join("\n"),
		);
		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { acme: 123456 } }));

		const image = registry.getAll("all").find(model => model.provider === "acme" && model.id === "acme-draw");
		expect(image?.kind).toBe("image");
		expect(image?.contextWindow).not.toBe(123456);
	});

	test("clamps maxTokens that exceed the window", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example.com/v1",
				"    apiKey: ACME_KEY",
				"    api: openai-completions",
				"    models:",
				"      - id: acme-chat",
				"        maxTokens: 32000",
				"",
			].join("\n"),
		);
		const registry = registryWith(Settings.isolated({ "providers.contextWindows": { acme: 16000 } }));

		const model = registry.find("acme", "acme-chat");
		expect(model?.contextWindow).toBe(16000);
		expect(model?.maxTokens).toBe(16000);
	});

	test("a window written mid-session rebuilds the live catalog", async () => {
		// The registry is built outside the session (as the CLI does), so a later
		// setting change only reaches the models through the session's listener.
		const settings = Settings.isolated();
		const registry = registryWith(settings);
		const model = registry.find("openai", "gpt-5.4");
		if (!model) throw new Error("Expected bundled model openai/gpt-5.4");
		expect(model.contextWindow).not.toBe(123456);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		// The listener fires on a microtask and its rebuild is async; spy first so
		// the test awaits the exact rebuild this change starts.
		const reapply = vi.spyOn(registry, "reapplyModelPolicies");

		cfgProvidersContextWindows.set(settings, { openai: 123456 });
		await Promise.resolve();
		expect(reapply).toHaveBeenCalled();
		await Promise.all(reapply.mock.results.map(result => result.value));

		expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(123456);
	});
});
