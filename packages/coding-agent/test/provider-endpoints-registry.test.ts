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
	tempDir = TempDir.createSync("@mars-endpoint-override-");
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

describe("providers.endpoints", () => {
	test("points a built-in provider at the configured endpoint", () => {
		const registry = registryWith(
			Settings.isolated({ "providers.endpoints": { openai: "https://proxy.example.com/v1" } }),
		);

		expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://proxy.example.com/v1");
	});

	test("applies to several providers at once and leaves others untouched", () => {
		const registry = registryWith(
			Settings.isolated({
				"providers.endpoints": {
					openai: "https://openai-proxy.example.com/v1",
					anthropic: "https://anthropic-proxy.example.com",
				},
			}),
		);

		expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://openai-proxy.example.com/v1");
		const anthropic = registry.find("anthropic", "claude-opus-4-8");
		expect(anthropic?.baseUrl).toBe("https://anthropic-proxy.example.com");
		expect(registry.find("google", "gemini-3-pro")?.baseUrl).not.toBe("https://anthropic-proxy.example.com");
	});

	test("a models.yml baseUrl for the same provider wins", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  openai:",
				"    baseUrl: https://from-models-yml.example.com/v1",
				"    apiKey: TEST_KEY",
				"",
			].join("\n"),
		);
		const registry = registryWith(
			Settings.isolated({ "providers.endpoints": { openai: "https://from-settings.example.com/v1" } }),
		);

		expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://from-models-yml.example.com/v1");
	});

	test("routes a custom provider's models to the configured endpoint", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme-original.example.com/v1",
				"    apiKey: ACME_KEY",
				"    api: openai-completions",
				"    models:",
				"      - id: acme-chat",
				"",
			].join("\n"),
		);
		const registry = registryWith(
			Settings.isolated({ "providers.endpoints": { acme: "https://acme-mirror.example.com/v1" } }),
		);

		// The models.yml block pins its own baseUrl, so it stays authoritative.
		expect(registry.find("acme", "acme-chat")?.baseUrl).toBe("https://acme-original.example.com/v1");
	});

	test("no configured endpoints leaves catalog hosts alone", () => {
		const registry = registryWith(Settings.isolated({}));
		const bundled = registry.find("openai", "gpt-5.4");
		expect(bundled?.baseUrl).toBeDefined();
		expect(bundled?.baseUrl).not.toContain("proxy.example.com");
	});

	test("retargets an implicit local server that carries a default host", () => {
		const registry = registryWith(
			Settings.isolated({
				"providers.endpoints": {
					ollama: "http://127.0.0.1:9999",
					"lm-studio": "http://127.0.0.1:7777/v1",
				},
			}),
		);

		expect(registry.getProviderBaseUrl("ollama")).toBe("http://127.0.0.1:9999");
		expect(registry.getProviderBaseUrl("lm-studio")).toBe("http://127.0.0.1:7777/v1");
	});

	test("retargets a configured discovery provider that pins no baseUrl", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({ data: [{ id: "endpoint-chat" }] });
			},
		});
		try {
			fs.writeFileSync(
				modelsPath,
				[
					"providers:",
					"  acme:",
					"    apiKey: ACME_KEY",
					"    api: openai-completions",
					"    discovery:",
					"      type: openai-models-list",
					"",
				].join("\n"),
			);
			const endpoint = `http://127.0.0.1:${server.port}/v1`;
			const registry = new ModelRegistry(authStorage, modelsPath, {
				settings: Settings.isolated({ "providers.endpoints": { acme: endpoint } }),
				cacheDbPath: path.join(tempDir.path(), "models.db"),
				fetch: (input, init) => fetch(input, init),
			});
			expect(registry.getError()).toBeUndefined();

			await registry.refreshProvider("acme", "online");

			// Discovery must probe the configured endpoint, not a catalog host.
			expect(requests).toEqual(["/v1/models"]);
			const discovered = registry.find("acme", "endpoint-chat");
			expect(discovered?.baseUrl).toBe(endpoint);
		} finally {
			server.stop(true);
		}
	});
});
