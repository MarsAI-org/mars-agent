/**
 * Orchestrator mode: the in-session switch behind `/orchestrate`.
 *
 * The `orchestrate` tool and its engine have been complete for a while, but the
 * only way in was a settings key (`orchestrator.enabled`), which meant leaving
 * the session, editing config, and restarting before the tool even appeared in
 * the toolset. This module owns the toggle: it flips the setting, swaps the
 * session toolset so the tool is live for the next turn, and reports what
 * changed.
 *
 * Deliberately small and UI-free so the slash command, the future board mount,
 * and tests all share one implementation.
 */

import type { Settings } from "../config/settings";
import { cfgOrchestratorEnabled, cfgOrchestratorMode, cfgOrchestratorMaxConcurrency } from "./settings";

/** What the caller can do to the session's active toolset. */
export interface OrchestratorSessionTools {
	getEnabledToolNames(): string[];
	setActiveToolsByName(names: string[]): Promise<void>;
	hasBuiltInTool(name: string): boolean;
}

export interface OrchestratorModeResult {
	readonly enabled: boolean;
	readonly changed: boolean;
	/** Human-readable line for the status area. */
	readonly message: string;
}

/** `true` when the orchestrator tool should be part of the active toolset. */
export function orchestratorToolsEnabled(settings: Settings): boolean {
	return cfgOrchestratorEnabled.get(settings);
}

/**
 * Turn orchestrator mode on or off.
 *
 * Turning it on adds the `orchestrate` tool to the active set so the next turn
 * can use it without a restart. Turning it off removes only that tool: every
 * other selection the user made stays exactly as it was.
 */
export async function setOrchestratorMode(
	settings: Settings,
	session: OrchestratorSessionTools,
	enabled: boolean,
): Promise<OrchestratorModeResult> {
	const current = orchestratorToolsEnabled(settings);
	const enabledTools = session.getEnabledToolNames();
	const hasTool = enabledTools.includes("orchestrate");

	if (enabled === current && hasTool === enabled) {
		return {
			enabled,
			changed: false,
			message: enabled ? "Orchestrator mode is already on." : "Orchestrator mode is already off.",
		};
	}

	if (enabled) {
		cfgOrchestratorEnabled.set(settings, true);
		// The tool is registered as a builtin unconditionally, so activating the
		// name is enough; a session that cannot see it was built without it.
		if (!hasTool && session.hasBuiltInTool("orchestrate")) {
			await session.setActiveToolsByName([...enabledTools, "orchestrate"]);
		}
		return {
			enabled: true,
			changed: true,
			message: "Orchestrator mode on. The agent can now fan work out with the orchestrate tool.",
		};
	}

	cfgOrchestratorEnabled.set(settings, false);
	if (hasTool) {
		await session.setActiveToolsByName(enabledTools.filter(name => name !== "orchestrate"));
	}
	return { enabled: false, changed: true, message: "Orchestrator mode off." };
}

/** One-line summary for `/orchestrate status` and the autocomplete description. */
export function describeOrchestratorMode(settings: Settings): string {
	if (!orchestratorToolsEnabled(settings)) return "Orchestrator: off";
	const mode = cfgOrchestratorMode.get(settings);
	const workers = cfgOrchestratorMaxConcurrency.get(settings);
	return `Orchestrator: on (${mode}, up to ${workers} workers)`;
}

/** Axes `/orchestrate` accepts, for usage errors and help text. */
export const ORCHESTRATOR_USAGE = [
	"on — enable orchestrator mode for this session",
	"off — disable it and drop the orchestrate tool",
	"status — show the current mode, fan-out policy, and worker cap",
	"mode <auto|single|parallel> — set the fan-out policy",
	"workers <n> — set the maximum concurrent workers",
].join("\n  ");

/**
 * Apply a subcommand, returning the status line.
 *
 * Kept separate from the slash-command definition so the argument grammar is
 * testable without a TUI runtime.
 */
export async function applyOrchestratorCommand(
	settings: Settings,
	session: OrchestratorSessionTools,
	args: string,
): Promise<string> {
	const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	switch (verb.toLowerCase()) {
		case "on":
		case "enable":
		case "start":
			return (await setOrchestratorMode(settings, session, true)).message;
		case "off":
		case "disable":
		case "stop":
			return (await setOrchestratorMode(settings, session, false)).message;
		case "status":
			return describeOrchestratorMode(settings);
		case "mode": {
			const value = rest[0]?.toLowerCase();
			if (value !== "auto" && value !== "single" && value !== "parallel") {
				return "Usage: /orchestrate mode <auto|single|parallel>";
			}
			cfgOrchestratorMode.set(settings, value);
			return `Fan-out policy set to ${value}.`;
		}
		case "workers": {
			const raw = rest[0];
			const workers = Number(raw);
			if (!raw || !Number.isSafeInteger(workers) || workers < 1) {
				return "Usage: /orchestrate workers <positive integer>";
			}
			cfgOrchestratorMaxConcurrency.set(settings, workers);
			return `Concurrent workers capped at ${workers}.`;
		}
		default:
			return `Unknown /orchestrate subcommand "${verb}".\n  ${ORCHESTRATOR_USAGE}`;
	}
}
