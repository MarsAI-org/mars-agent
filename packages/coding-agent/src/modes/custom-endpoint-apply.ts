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
import { cfgProvidersContextWindows } from "../config/provider-context-window-settings";
import { addProvider } from "../cli/models-provider-cli";

/** Structural subset of the wizard's result (the component's own union). */
export type CustomEndpointResult =
	| { kind: "override"; provider: string; baseUrl: string; apiKey?: string; maxContext?: number }
	| {
			kind: "custom";
			provider: string;
			baseUrl: string;
			api: string;
			apiKey?: string;
			maxContext?: number;
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
		// Only touch the window record when the wizard asked for one, so a blank
		// field keeps whatever `providers.contextWindows` already holds.
		if (result.maxContext !== undefined) {
			const windows = { ...cfgProvidersContextWindows.get(targets.settings) };
			windows[result.provider] = result.maxContext;
			cfgProvidersContextWindows.set(targets.settings, windows);
		}
		await targets.settings.flush();
		// `keys.setConfig` is an in-memory override only; the endpoint setting
		// outlives the process, so the credential has to land in the store.
		if (credential) await targets.authStorage.credentials.set(result.provider, { type: "api_key", key: credential });
		await targets.modelRegistry.refresh("online");
		const window = result.maxContext === undefined ? "" : `, ${result.maxContext}-token context window`;
		return `Custom endpoint set for ${result.provider}: ${result.baseUrl}${window}`;
	}

	const declared = result.models !== undefined && result.models.length > 0;
	await addProvider({
		id: result.provider,
		baseUrl: result.baseUrl,
		api: result.api as Parameters<typeof addProvider>[0]["api"],
		apiKey: credential,
		// Mirror the wizard's default: an endpoint that declares no models is
		// discovered from its /models list, which is what the add flow requires.
		discovery: (result.discovery ?? (declared ? undefined : "openai-models-list")) as
			| Parameters<typeof addProvider>[0]["discovery"]
			| undefined,
		models: result.models,
		// A declared id carries the window itself; a discovered catalog stores it
		// provider-wide, since its ids are only fetched later.
		maxContext: result.maxContext,
		settings: targets.settings,
	});
	await targets.modelRegistry.refresh("online");
	const window = result.maxContext === undefined ? "" : `, ${result.maxContext}-token context window`;
	return `Added custom provider "${result.provider}" (${result.baseUrl}${window})`;
}
