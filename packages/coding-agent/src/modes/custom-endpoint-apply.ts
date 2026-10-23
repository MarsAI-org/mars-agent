/**
 * Apply a wizard result: the half of the custom-endpoint flow that touches
 * disk.
 *
 * Both entry points (the session's editor slot and the fullscreen setup
 * wizard) collect answers with the same component, so the write itself lives
 * here once. An override goes to `providers.endpoints` because the provider
 * keeps its catalog and credentials; a new provider goes through the same
 * add-provider path the CLI uses, which validates against the real loader and
 * replaces `models.yml` atomically.
 */
import type { Settings } from "../config/settings";
import type { ModelRegistry } from "../config/model-registry";
import type { AuthStorage } from "../session/auth-storage";
import { cfgProvidersEndpoints } from "../config/provider-endpoint-settings";
import { addProvider } from "../cli/models-provider-cli";

/** Structural subset of the wizard's result (the component's own union). */
export type CustomEndpointResult =
	| { kind: "override"; provider: string; baseUrl: string; apiKey?: string }
	| {
			kind: "custom";
			provider: string;
			baseUrl: string;
			api: string;
			apiKey?: string;
			discovery?: string;
			models?: string[];
	  };

export interface CustomEndpointTargets {
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: Pick<ModelRegistry, "refresh">;
}

/**
 * Persist `result`, then refresh the catalog so the new endpoint takes effect.
 *
 * @throws when the provider block fails validation; the caller reports it.
 */
export async function applyCustomEndpointResult(
	result: CustomEndpointResult,
	targets: CustomEndpointTargets,
): Promise<string> {
	const credential = result.apiKey?.trim();
	if (result.kind === "override") {
		const current = { ...cfgProvidersEndpoints.get(targets.settings) };
		current[result.provider] = result.baseUrl;
		cfgProvidersEndpoints.set(targets.settings, current);
		await targets.settings.flush();
		// `keys.setConfig` is an in-memory override only; the endpoint setting
		// outlives the process, so the credential has to land in the store.
		if (credential) await targets.authStorage.credentials.set(result.provider, { type: "api_key", key: credential });
		await targets.modelRegistry.refresh("online");
		return `Custom endpoint set for ${result.provider}: ${result.baseUrl}`;
	}

	await addProvider({
		id: result.provider,
		baseUrl: result.baseUrl,
		api: result.api as Parameters<typeof addProvider>[0]["api"],
		apiKey: credential,
		// Mirror the wizard's default: an endpoint that declares no models is
		// discovered from its /models list, which is what the add flow requires.
		discovery: (result.discovery ??
			(result.models && result.models.length > 0 ? undefined : "openai-models-list")) as
			| Parameters<typeof addProvider>[0]["discovery"]
			| undefined,
		models: result.models,
	});
	await targets.modelRegistry.refresh("online");
	return `Added custom provider "${result.provider}" (${result.baseUrl})`;
}
