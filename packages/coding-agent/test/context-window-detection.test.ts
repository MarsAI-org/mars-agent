import { describe, expect, test } from "bun:test";
import {
	advertisedWindowOf,
	detectAdvertisedContextWindows,
	isLoopbackBaseUrl,
	modelsListUrl,
	windowsForDeclaredModels,
} from "@marsai-org/coding-agent/config/context-window-detection";

/** Endpoint stub returning one JSON payload for any GET. */
function jsonFetch(payload: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("models list URL", () => {
	test("injects /v1 like discovery does", () => {
		expect(modelsListUrl("https://gateway.example.com")).toBe("https://gateway.example.com/v1/models");
		expect(modelsListUrl("https://gateway.example.com/")).toBe("https://gateway.example.com/v1/models");
	});

	test("keeps a base that already carries a version path", () => {
		expect(modelsListUrl("https://api.example.com/v3/compat")).toBe("https://api.example.com/v3/compat/v1/models");
		expect(modelsListUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1/models");
	});
});

describe("advertised window per models row", () => {
	test("reads context_length and max_model_len", () => {
		expect(advertisedWindowOf({ id: "a", context_length: 200_000 })).toBe(200_000);
		expect(advertisedWindowOf({ id: "b", max_model_len: 131_072 })).toBe(131_072);
		// Numeric text is accepted: some gateways quote their limits.
		expect(advertisedWindowOf({ id: "c", context_length: "65536" })).toBe(65_536);
	});

	test("sums the OpenRouter limits pair", () => {
		expect(advertisedWindowOf({ id: "a", limits: { max_input_tokens: 128_000, max_output_tokens: 32_000 } })).toBe(
			160_000,
		);
	});

	test("is undefined when the row states no usable window", () => {
		expect(advertisedWindowOf({ id: "a" })).toBeUndefined();
		expect(advertisedWindowOf({ id: "a", context_length: 0 })).toBeUndefined();
		expect(advertisedWindowOf({ id: "a", context_length: "auto" })).toBeUndefined();
		// A partial limits pair says nothing about the whole window.
		expect(advertisedWindowOf({ id: "a", limits: { max_input_tokens: 1000 } })).toBeUndefined();
	});
});

describe("loopback detection", () => {
	test("recognizes this machine's own hosts", () => {
		expect(isLoopbackBaseUrl("http://127.0.0.1:8080/v1")).toBe(true);
		expect(isLoopbackBaseUrl("http://localhost:11434")).toBe(true);
		expect(isLoopbackBaseUrl("https://gateway.example.com/v1")).toBe(false);
		expect(isLoopbackBaseUrl("not a url")).toBe(false);
	});
});

describe("detectAdvertisedContextWindows", () => {
	test("lists what the endpoint advertises, in order", async () => {
		const detected = await detectAdvertisedContextWindows({
			baseUrl: "https://gateway.example.com/v1",
			fetchImpl: jsonFetch({
				data: [{ id: "big", context_length: 1_000_000 }, { id: "small", context_length: 8_192 }, { id: "silent" }],
			}),
		});

		expect(detected.models).toEqual([
			{ id: "big", contextWindow: 1_000_000 },
			{ id: "small", contextWindow: 8_192 },
		]);
		expect(detected.probedUrl).toBe("https://gateway.example.com/v1/models");
	});

	test("sends the credential so a gated model list answers", async () => {
		let seen: string | null = null;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			seen = new Headers(init.headers).get("authorization");
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		await detectAdvertisedContextWindows({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "  secret-token  ",
			fetchImpl,
		});

		expect<string | null>(seen).toBe("Bearer secret-token");
	});

	test("yields nothing instead of throwing when the probe fails", async () => {
		const unreachable = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const unauthorized = jsonFetch({ error: "nope" }, 401);

		for (const fetchImpl of [unreachable, unauthorized]) {
			const detected = await detectAdvertisedContextWindows({
				baseUrl: "https://gateway.example.com/v1",
				fetchImpl,
			});
			expect(detected.models).toEqual([]);
		}
	});
});

describe("windowsForDeclaredModels", () => {
	const advertised = {
		probedUrl: "https://gateway.example.com/v1/models",
		models: [
			{ id: "vendor/big-model", contextWindow: 200_000 },
			{ id: "exact-id", contextWindow: 32_000 },
			{ id: "unrelated", contextWindow: 4_000 },
		],
	};

	test("matches declared ids exactly and by their last path segment", () => {
		const matched = windowsForDeclaredModels(advertised, ["exact-id", "big-model", "missing"]);

		expect(matched.get("exact-id")).toBe(32_000);
		// `big-model` was declared without the vendor prefix the endpoint uses.
		expect(matched.get("big-model")).toBe(200_000);
		expect(matched.has("missing")).toBe(false);
	});

	test("an exact id outranks a tail match", () => {
		const matched = windowsForDeclaredModels(
			{
				probedUrl: "u",
				models: [
					{ id: "vendor/x", contextWindow: 1 },
					{ id: "x", contextWindow: 2 },
				],
			},
			["x"],
		);

		expect(matched.get("x")).toBe(2);
	});
});
