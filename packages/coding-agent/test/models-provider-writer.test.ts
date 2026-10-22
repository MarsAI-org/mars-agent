import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { buildProviderConfig, validateAddProviderOptions } from "@marsai-org/coding-agent/cli/models-provider-cli";
import {
	defaultModelsConfigPath,
	findModelsConfigProblem,
	listProviderBlocks,
	removeProviderBlock,
	upsertProviderBlock,
} from "@marsai-org/coding-agent/config/models-config-writer";
import { setAgentDir, TempDir } from "@marsai-org/utils";

let tempDir: TempDir;
let originalAgentDir: string;

beforeEach(() => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR ?? "";
	tempDir = TempDir.createSync("@mars-models-writer-");
	setAgentDir(tempDir.path());
});

afterEach(async () => {
	if (originalAgentDir) process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
	await tempDir.remove().catch(() => {});
});

describe("models-config-writer", () => {
	test("creates providers section when the file is empty", () => {
		const text = upsertProviderBlock("", "acme", { baseUrl: "https://api.acme.test/v1" });
		expect(listProviderBlocks(text)).toEqual(["acme"]);
		const parsed = YAML.parse(text) as { providers: Record<string, unknown> };
		expect(parsed.providers.acme).toEqual({ baseUrl: "https://api.acme.test/v1" });
	});

	test("appends into an existing providers section and preserves comments", () => {
		const original = `# my models
providers:
  local-gw:
    baseUrl: http://127.0.0.1:1234/v1

# keep me
other: 1
`;
		const text = upsertProviderBlock(original, "acme", {
			baseUrl: "https://api.acme.test/v1",
			apiKey: "ACME_KEY",
		});
		expect(text).toContain("# my models");
		expect(text).toContain("# keep me");
		expect(listProviderBlocks(text)).toEqual(["local-gw", "acme"]);
		const parsed = YAML.parse(text) as { providers: Record<string, { baseUrl: string }> };
		expect(parsed.providers["local-gw"]!.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(parsed.providers.acme!.baseUrl).toBe("https://api.acme.test/v1");
	});

	test("replaces an existing block idempotently", () => {
		const first = upsertProviderBlock("", "acme", { baseUrl: "https://one.test/v1" });
		const second = upsertProviderBlock(first, "acme", { baseUrl: "https://two.test/v1" });
		const providers = listProviderBlocks(second);
		expect(providers).toEqual(["acme"]);
		const parsed = YAML.parse(second) as { providers: Record<string, { baseUrl: string }> };
		expect(parsed.providers.acme!.baseUrl).toBe("https://two.test/v1");
	});

	test("expands an empty inline providers map", () => {
		const text = upsertProviderBlock("providers: {}\n", "acme", { baseUrl: "https://acme.test/v1" });
		expect(listProviderBlocks(text)).toEqual(["acme"]);
	});

	test("expands a non-empty inline providers map into blocks", () => {
		const text = upsertProviderBlock("providers: {existing: {baseUrl: https://existing.test/v1}}\n", "acme", {
			baseUrl: "https://acme.test/v1",
		});
		expect(listProviderBlocks(text)).toEqual(["existing", "acme"]);
		const parsed = YAML.parse(text) as { providers: Record<string, { baseUrl: string }> };
		expect(parsed.providers.existing!.baseUrl).toBe("https://existing.test/v1");
		expect(parsed.providers.acme!.baseUrl).toBe("https://acme.test/v1");
	});

	test("removes a block and leaves the rest alone", () => {
		const text = upsertProviderBlock(upsertProviderBlock("", "one", { baseUrl: "https://one.test/v1" }), "two", {
			baseUrl: "https://two.test/v1",
		});
		const { text: removed, removed: didRemove } = removeProviderBlock(text, "one");
		expect(didRemove).toBe(true);
		expect(listProviderBlocks(removed)).toEqual(["two"]);
	});

	test("reports missing provider on remove", () => {
		const { removed } = removeProviderBlock("providers:\n  one:\n    baseUrl: https://one.test/v1\n", "nope");
		expect(removed).toBe(false);
	});

	test("validates a writable document through the real loader", async () => {
		const valid = upsertProviderBlock(
			"",
			"acme",
			buildProviderConfig({
				id: "acme",
				baseUrl: "https://api.acme.test/v1",
				api: "openai-completions",
				apiKey: "ACME_API_KEY",
				models: ["acme-chat"],
			}),
		);
		expect(await findModelsConfigProblem(valid)).toBeUndefined();
	});

	test("default path resolves inside the agent dir", () => {
		expect(defaultModelsConfigPath()).toBe(path.join(tempDir.path(), "models.yml"));
		expect(fs.existsSync(path.dirname(defaultModelsConfigPath()))).toBe(true);
	});
});

describe("buildProviderConfig", () => {
	test("declares models and omits empty fields", () => {
		const config = buildProviderConfig({
			id: "acme",
			baseUrl: "https://api.acme.test/v1",
			api: "anthropic-messages",
			apiKey: "ACME_KEY",
			models: ["claude-local"],
		});
		expect(config).toEqual({
			baseUrl: "https://api.acme.test/v1",
			apiKey: "ACME_KEY",
			api: "anthropic-messages",
			models: [{ id: "claude-local" }],
		});
	});

	test("marks a provider with no credential keyless", () => {
		const config = buildProviderConfig({
			id: "acme",
			baseUrl: "http://127.0.0.1:8080/v1",
			models: ["local-chat"],
		});
		expect(config.apiKey).toBeUndefined();
		expect(config.auth).toBe("none");
	});

	test("writes discovery instead of a model list", () => {
		const config = buildProviderConfig({
			id: "acme",
			baseUrl: "https://api.acme.test/v1",
			apiKey: "ACME_KEY",
			discovery: "openai-models-list",
		});
		expect(config.discovery).toEqual({ type: "openai-models-list" });
		expect(config.models).toBeUndefined();
	});
});

describe("validateAddProviderOptions", () => {
	test("rejects built-in provider ids", () => {
		const problem = validateAddProviderOptions({
			id: "openai",
			baseUrl: "https://proxy.test/v1",
			discovery: "openai-models-list",
		});
		expect(problem).toContain("built-in provider");
	});

	test("rejects non-absolute base URLs", () => {
		expect(validateAddProviderOptions({ id: "acme", baseUrl: "acme.test/v1", discovery: "none" })).toContain(
			"absolute URL",
		);
	});

	test("requires models or discovery", () => {
		expect(validateAddProviderOptions({ id: "acme", baseUrl: "https://acme.test/v1" })).toContain(
			"at least one model id",
		);
	});

	test("accepts a valid custom provider", () => {
		expect(
			validateAddProviderOptions({
				id: "acme",
				baseUrl: "https://acme.test/v1",
				models: ["acme-chat"],
			}),
		).toBeUndefined();
	});
});
