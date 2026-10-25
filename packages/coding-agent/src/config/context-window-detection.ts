/**
 * Read the context windows an OpenAI-compatible endpoint advertises.
 *
 * The custom-endpoint wizard asks for a provider-wide window because a gateway
 * often states none, or states a smaller one than it accepts. Leaving the field
 * blank therefore means "the endpoint decides", and the endpoint's own
 * `/models` list is the only place it can say so: `context_length` (vLLM,
 * LiteLLM, OpenRouter), `max_model_len` (vLLM's newer field), or
 * `limits.max_input_tokens + limits.max_output_tokens` (OpenRouter).
 *
 * This is deliberately not the full discovery pipeline: the wizard needs one
 * number per model id, without building models, resolving catalog references,
 * or touching the registry.
 */
import { isRecord, logger } from "@marsai-org/utils";

/** One model id the endpoint advertised a window for. */
export interface AdvertisedModelWindow {
	id: string;
	contextWindow: number;
}

/** Advertised windows per model id, in endpoint order. Empty when it states none. */
export interface AdvertisedContextWindows {
	models: AdvertisedModelWindow[];
	/** Endpoint URL actually probed, for the wizard's status line. */
	probedUrl: string;
}

/** Discovery probe budget for a remote endpoint; loopback servers answer in milliseconds. */
const REMOTE_PROBE_TIMEOUT_MS = 10_000;
const LOOPBACK_PROBE_TIMEOUT_MS = 2_000;

/** Absolute URL of the endpoint's model list, with `/v1` injected like discovery does. */
export function modelsListUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return `${trimmed}/models`;
	}
	// A base already rooted at a versioned path keeps it; everything else gets
	// `/v1`, matching `normalizeOpenAIModelsListBaseUrl` in model-discovery.
	if (!/\/v\d+$/.test(parsed.pathname)) parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v1`;
	return `${parsed.origin}${parsed.pathname}/models`;
}

/** Positive token count from a number or a numeric string, or undefined. */
function positiveTokens(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
	}
	return undefined;
}

/**
 * Context window one `/models` row advertises, or undefined.
 *
 * `context_length`/`max_model_len` are the whole window; the OpenRouter `limits`
 * pair is split into input and output, so their sum is what the model accepts.
 */
export function advertisedWindowOf(item: Record<string, unknown>): number | undefined {
	const direct = positiveTokens(item.context_length) ?? positiveTokens(item.max_model_len);
	if (direct !== undefined) return direct;
	if (!isRecord(item.limits)) return undefined;
	const input = positiveTokens(item.limits.max_input_tokens);
	const output = positiveTokens(item.limits.max_output_tokens);
	if (input === undefined || output === undefined) return undefined;
	const total = input + output;
	return Number.isSafeInteger(total) ? total : undefined;
}

/** Whether a base URL points at this machine, i.e. a local server that answers immediately. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Probe an endpoint's model list for advertised context windows.
 *
 * Never throws: a gateway that is unreachable, unauthorized, or simply silent
 * about windows yields an empty list, and the caller keeps whatever the model
 * would otherwise resolve. `apiKey` is attached as a bearer token when present,
 * because a gateway can gate `/models` behind the same credential as its chat
 * endpoint.
 */
export async function detectAdvertisedContextWindows(options: {
	baseUrl: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<AdvertisedContextWindows> {
	const probedUrl = modelsListUrl(options.baseUrl);
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = isLoopbackBaseUrl(options.baseUrl) ? LOOPBACK_PROBE_TIMEOUT_MS : REMOTE_PROBE_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const credential = options.apiKey?.trim();
	try {
		const response = await fetchImpl(probedUrl, {
			headers: credential ? { Authorization: `Bearer ${credential}` } : {},
			signal,
		});
		if (!response.ok) return { models: [], probedUrl };
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return { models: [], probedUrl };
		const models: AdvertisedModelWindow[] = [];
		for (const item of payload.data) {
			if (!isRecord(item)) continue;
			const id = typeof item.id === "string" ? item.id.trim() : "";
			if (!id) continue;
			const contextWindow = advertisedWindowOf(item);
			if (contextWindow === undefined) continue;
			models.push({ id, contextWindow });
		}
		return { models, probedUrl };
	} catch (error) {
		logger.debug("context-window detection probe failed", {
			url: probedUrl,
			error: error instanceof Error ? error.message : String(error),
		});
		return { models: [], probedUrl };
	}
}

/**
 * The one window every detected model agrees on, or undefined when the endpoint
 * answered for none of them or for models with different windows.
 *
 * A provider-wide setting can only hold a single number, so a mixed answer has
 * no faithful provider-wide form: pinning the smaller value would overstate a
 * model's real limit and pinning the larger one would waste it.
 */
export function uniformDetectedWindow(detected: readonly AdvertisedModelWindow[]): number | undefined {
	if (detected.length === 0) return undefined;
	const first = detected[0]!.contextWindow;
	return detected.every(entry => entry.contextWindow === first) ? first : undefined;
}

/**
 * Windows for the wizard's declared model ids, keeping declared order.
 *
 * Declared ids are matched exactly first, then by the id's last path segment:
 * a gateway that serves `vendor/model` for a declared `model` still answers for
 * it. Ids the endpoint says nothing about are absent, so the caller falls back
 * to the endpoint's default for those alone.
 */
export function windowsForDeclaredModels(
	advertised: AdvertisedContextWindows,
	declaredIds: readonly string[],
): Map<string, number> {
	const byId = new Map<string, number>();
	const byTail = new Map<string, number>();
	for (const model of advertised.models) {
		if (!byId.has(model.id)) byId.set(model.id, model.contextWindow);
		const tail = model.id.slice(model.id.lastIndexOf("/") + 1);
		if (!byTail.has(tail)) byTail.set(tail, model.contextWindow);
	}
	const matched = new Map<string, number>();
	for (const id of declaredIds) {
		const window = byId.get(id) ?? byTail.get(id) ?? byTail.get(id.slice(id.lastIndexOf("/") + 1));
		if (window !== undefined) matched.set(id, window);
	}
	return matched;
}
