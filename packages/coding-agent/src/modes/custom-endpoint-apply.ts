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
import { detectAdvertisedContextWindows, uniformDetectedWindow } from "../config/context-window-detection";

/** Window the wizard detected for one model id. */
export interface DetectedContextWindow {
	id: string;
	contextWindow: number;
}

/** Structural subset of the wizard's result (the component's own union). */
export type CustomEndpointResult =
	| {
			kind: "override";
			provider: string;
			baseUrl: string;
			apiKey?: string;
			maxContext?: number;
			detectedContextWindows?: DetectedContextWindow[];
	  }
	| {
			kind: "custom";
			provider: string;
			baseUrl: string;
			api: string;
			apiKey?: string;
			maxContext?: number;
			detectedContextWindows?: DetectedContextWindow[];
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
	const detected = result.detectedContextWindows ?? [];
	if (result.kind === "override") {
		const current = { ...cfgProvidersEndpoints.get(targets.settings) };
		current[result.provider] = result.baseUrl;
		cfgProvidersEndpoints.set(targets.settings, current);
		// Only touch the window record when the wizard asked for one, so a blank
		// field keeps whatever `providers.contextWindows` already holds. A
		// detected window is usable here only when every model the endpoint
		// answered for agrees on it: the record is provider-wide, so a mixed set
		// would silently pin the smaller models above their real limit. A
		// mixed or single-model answer is left to the catalog instead.
		const detectedWindow = uniformDetectedWindow(detected);
		const window = result.maxContext ?? detectedWindow;
		if (window !== undefined) {
			const windows = { ...cfgProvidersContextWindows.get(targets.settings) };
			windows[result.provider] = window;
			cfgProvidersContextWindows.set(targets.settings, windows);
		}
		await targets.settings.flush();
		// `keys.setConfig` is an in-memory override only; the endpoint setting
		// outlives the process, so the credential has to land in the store.
		if (credential) await targets.authStorage.credentials.set(result.provider, { type: "api_key", key: credential });
		await targets.modelRegistry.refresh("online");
		return `Custom endpoint set for ${result.provider}: ${result.baseUrl}${describeAppliedWindow(result.maxContext, detected)}`;
	}

	const declared = result.models !== undefined && result.models.length > 0;
	// A declared id carries its own window in the block. The endpoint's answer
	// is folded in per id; ids it said nothing about fall back to the
	// provider-wide value the user typed, if any.
	const byId = new Map(detected.map(entry => [entry.id, entry.contextWindow]));
	const models = result.models?.map(id => {
		const contextWindow = byId.get(id) ?? byId.get(id.slice(id.lastIndexOf("/") + 1));
		return contextWindow === undefined ? id : { id, contextWindow };
	});
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
		models,
		// A discovered catalog has no ids at write time, so its window can only be
		// provider-wide. A uniform detected answer is exactly that value.
		maxContext: result.maxContext ?? (declared ? undefined : uniformDetectedWindow(detected)),
		settings: targets.settings,
	});
	await targets.modelRegistry.refresh("online");
	return `Added custom provider "${result.provider}" (${result.baseUrl}${describeAppliedWindow(result.maxContext, detected)})`;
}

/** Human-readable tail for the wizard's status line. */
function describeAppliedWindow(maxContext: number | undefined, detected: readonly DetectedContextWindow[]): string {
	if (maxContext !== undefined) return `, ${maxContext}-token context window`;
	const uniform = uniformDetectedWindow(detected);
	if (uniform !== undefined) return `, ${uniform}-token context window detected`;
	if (detected.length > 0) return `, context windows detected for ${detected.length} models`;
	return "";
}

/**
 * Endpoint probe behind the wizard's blank context-window field.
 *
 * A gateway that advertises nothing (or cannot be reached) yields an empty
 * list, which the wizard reads as "keep the endpoint's default".
 */
export async function detectContextWindowsForWizard(options: {
	baseUrl: string;
	apiKey?: string;
}): Promise<DetectedContextWindow[]> {
	const advertised = await detectAdvertisedContextWindows({ baseUrl: options.baseUrl, apiKey: options.apiKey });
	return advertised.models;
}
