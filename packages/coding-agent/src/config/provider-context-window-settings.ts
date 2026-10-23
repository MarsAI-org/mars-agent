/**
 * `providers.contextWindows` — per-provider context window overrides kept in
 * `config.yml`.
 *
 * A gateway in front of a model usually advertises no window, or a small one,
 * and the value users need is the one the gateway actually accepts. This
 * setting applies a window to every chat model of one provider id — built-in
 * or custom — without enumerating model ids in `models.yml`. An explicit
 * per-model `contextWindow` there still wins.
 *
 * The module lives beside the registry rather than in `session/settings.ts` so
 * `config/model-registry.ts` can read the handle without importing the whole
 * session settings graph.
 */
import { register } from "./registry";

const EMPTY_WINDOW_RECORD: Record<string, number> = {};
const DIGITS_PATTERN = /^\d+$/;

function isWindowRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A window as a token count, or `undefined`. Numeric text is accepted because
 * `config set providers.contextWindows.<id> 200000` writes the raw CLI string
 * into the record; JSON writes and `config.yml` itself use numbers.
 */
function windowOf(value: unknown): number | undefined {
	const count = typeof value === "string" && DIGITS_PATTERN.test(value.trim()) ? Number(value) : value;
	return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/** Positive integer window per provider; other entries are dropped. */
export function normalizeProviderContextWindows(value: unknown): Record<string, number> {
	const normalized: Record<string, number> = {};
	if (!isWindowRecord(value)) return normalized;
	for (const provider in value) {
		const window = windowOf(value[provider]);
		if (window !== undefined) normalized[provider] = window;
	}
	return normalized;
}

/**
 * Validated per-provider windows.
 *
 * @throws Error naming every provider whose window is not a positive integer.
 */
export function validateProviderContextWindows(value: unknown): Record<string, number> {
	if (isWindowRecord(value)) {
		const invalid: string[] = [];
		for (const provider in value) {
			if (windowOf(value[provider]) === undefined) invalid.push(provider);
		}
		if (invalid.length > 0) {
			throw new Error(`Provider context windows must be positive integers (tokens): ${invalid.join(", ")}`);
		}
	}
	return normalizeProviderContextWindows(value);
}

export const cfgProvidersContextWindows = register({
	id: "providers.contextWindows",
	type: "record",
	default: EMPTY_WINDOW_RECORD,
	validate: validateProviderContextWindows,
	normalize: validateProviderContextWindows,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Custom Context Windows",
		description:
			'Context window in tokens per provider id (for example {"my-gateway": 200000}). Applies to every chat model of built-in and custom providers. A contextWindow set for the same model in models.yml still wins.',
	},
});
