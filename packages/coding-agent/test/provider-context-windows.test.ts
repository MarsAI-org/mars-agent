import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@marsai-org/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import { AuthStorage } from "@marsai-org/coding-agent/session/auth-storage";
import { TempDir } from "@marsai-org/utils";

let tempDir: TempDir;
let modelsPath: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = TempDir.createSync("@mars-context-window-");
	modelsPath = path.join(tempDir.path(), "models.yml");
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(async () => {
	authStorage.close();
	resetSettingsForTest();
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
});
