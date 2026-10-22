/**
 * `providers.endpoints` — per-provider base-URL overrides kept in `config.yml`.
 *
 * A `models.yml` provider block is the canonical way to point a provider at
 * another host, but it requires redefining the provider there. This setting
 * changes the endpoint of any provider id — built-in or custom — without
 * touching the model catalog file, and follows the same request path as a
 * `models.yml` `baseUrl`.
 *
 * The module lives beside the registry rather than in `session/settings.ts` so
 * `config/model-registry.ts` can read the handle without importing the whole
 * session settings graph.
 */
import { register } from "./registry";

const EMPTY_ENDPOINT_RECORD: Record<string, string> = {};

/** Protocols that can address a model endpoint. `local:` carries on-device transports. */
const ENDPOINT_PROTOCOLS = new Set(["http:", "https:", "local:"]);

function isEndpointRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed endpoint per provider; entries that are blank or not strings are dropped. */
export function normalizeProviderEndpoints(value: unknown): Record<string, string> {
	const normalized: Record<string, string> = {};
	if (!isEndpointRecord(value)) return normalized;
	for (const provider in value) {
		const endpoint = value[provider];
		if (typeof endpoint !== "string") continue;
		const trimmed = endpoint.trim();
		if (trimmed.length > 0) normalized[provider] = trimmed;
	}
	return normalized;
}

/**
 * Validated per-provider base URLs.
 *
 * @throws Error naming every provider whose endpoint is not an absolute URL on
 * a supported protocol. A bare host such as `api.example.com/v1` is rejected
 * here: the request layer would otherwise treat it as a relative path.
 */
export function validateProviderEndpoints(value: unknown): Record<string, string> {
	if (isEndpointRecord(value)) {
		const invalid: string[] = [];
		for (const provider in value) {
			const endpoint = value[provider];
			if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
				invalid.push(provider);
				continue;
			}
			let protocol: string;
			try {
				protocol = new URL(endpoint.trim()).protocol;
			} catch {
				invalid.push(provider);
				continue;
			}
			if (!ENDPOINT_PROTOCOLS.has(protocol)) invalid.push(provider);
		}
		if (invalid.length > 0) {
			throw new Error(`Provider endpoints must be absolute URLs (http, https, or local): ${invalid.join(", ")}`);
		}
	}
	return normalizeProviderEndpoints(value);
}

export const cfgProvidersEndpoints = register({
	id: "providers.endpoints",
	type: "record",
	default: EMPTY_ENDPOINT_RECORD,
	validate: validateProviderEndpoints,
	normalize: validateProviderEndpoints,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Custom Endpoints",
		description:
			'Base URL per provider id, as a JSON record (for example {"openai": "https://my-proxy/v1"}). Applies to built-in and custom providers, and to their model discovery. A baseUrl set for the same provider in models.yml wins over this entry.',
	},
});
