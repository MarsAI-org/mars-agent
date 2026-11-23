/**
 * Orchestrator mode: the in-session switch behind `/swarm` (and `/orchestrate`).
 *
 * The `orchestrate` tool and its engine have been complete for a while, but the
 * only way in was a settings key (`orchestrator.enabled`), which meant leaving
 * the session, editing config, and restarting before the tool even appeared in
 * the toolset. This module owns the toggle: it flips the setting, reconciles
 * session builtin tools, swaps the session toolset so the tool is live for the
 * next turn, and reports what changed.
 *
 * Deliberately small and UI-free so the slash command, the live board mount,
 * and tests all share one implementation.
 */

import type { PlatformEnvironment } from "@marsai-org/utils/platform";
import type { Settings } from "../config/settings";
import { getActiveSwarmRun, SwarmRunStore } from "./run-store";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMode,
	resolveOrchestratorLimits,
} from "./settings";

/** Maximum concurrent workers accepted by `/swarm workers <n>`. */
export const MAX_ORCHESTRATOR_WORKERS = 64;

/** What the caller can do to the session's active toolset. */
export interface OrchestratorSessionTools {
	getEnabledToolNames(): string[];
	setActiveToolsByName(names: string[]): Promise<void>;
	hasBuiltInTool(name: string): boolean;
	reconcileBuiltinTools?(): Promise<unknown>;
}

export interface OrchestratorModeResult {
	readonly enabled: boolean;
	readonly changed: boolean;
	/** Human-readable line for the status area. */
	readonly message: string;
}

export interface ApplyOrchestratorCommandOptions {
	readonly store?: SwarmRunStore;
	readonly platformContext?: PlatformEnvironment;
}

/** `true` when the orchestrator tool should be part of the active toolset. */
export function orchestratorToolsEnabled(settings: Settings): boolean {
	return cfgOrchestratorEnabled.get(settings);
}

/**
 * Turn orchestrator mode on or off.
 *
 * Turning it on sets `orchestrator.enabled`, reconciles builtin tools so a
 * session that booted with the setting off registers `orchestrate` on the spot,
 * and adds `orchestrate` to the active toolset. If `orchestrate` remains
 * unavailable after reconciling (e.g. a restricted subagent session at max
 * recursion depth), the setting is reverted and an explanatory message is
 * returned instead of falsely claiming swarm mode is active.
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
		await session.reconcileBuiltinTools?.();
		const latestTools = session.getEnabledToolNames();
		const latestHasTool = latestTools.includes("orchestrate");

		if (!latestHasTool && !session.hasBuiltInTool("orchestrate")) {
			cfgOrchestratorEnabled.set(settings, current);
			return {
				enabled: false,
				changed: false,
				message: "Swarm mode is unavailable in this session (subagent spawning is restricted).",
			};
		}

		if (!latestHasTool && session.hasBuiltInTool("orchestrate")) {
			await session.setActiveToolsByName([...latestTools, "orchestrate"]);
		}
		return {
			enabled: true,
			changed: true,
			message: "Orchestrator mode on. The agent can now fan work out with the orchestrate tool.",
		};
	}

	cfgOrchestratorEnabled.set(settings, false);
	await session.reconcileBuiltinTools?.();
	const latestTools = session.getEnabledToolNames();
	if (latestTools.includes("orchestrate")) {
		await session.setActiveToolsByName(latestTools.filter(name => name !== "orchestrate"));
	}
	return { enabled: false, changed: true, message: "Orchestrator mode off." };
}

/** One-line summary for `/swarm status` and the autocomplete description. */
export function describeOrchestratorMode(settings: Settings, platformContext?: PlatformEnvironment): string {
	const base = !orchestratorToolsEnabled(settings)
		? "Orchestrator: off"
		: `Orchestrator: on (${cfgOrchestratorMode.get(settings)}, up to ${resolveOrchestratorLimits(settings, platformContext).concurrency} workers)`;
	const activeRun = getActiveSwarmRun();
	if (!activeRun || !activeRun.isActive()) return base;
	const panes = activeRun.getSnapshot();
	const completed = panes.filter(pane => pane.state === "completed").length;
	return `${base} · active run ${activeRun.planId} (${completed}/${panes.length} completed)`;
}

/** Axes `/swarm` (and `/orchestrate`) accepts, for usage errors and help text. */
export const ORCHESTRATOR_USAGE = [
	"on — enable orchestrator mode for this session",
	"off — disable it and drop the orchestrate tool",
	"status — show the current mode, fan-out policy, worker cap, and active run",
	"mode <auto|single|parallel> — set the fan-out policy",
	"workers <1..64> — set the maximum concurrent workers",
	"runs — list recent persisted swarm runs",
	"board [planId] — open the live Swarm Board overlay",
	"run <spec-file> — execute a declarative YAML/JSON swarm spec",
	"resume <planId> — resume incomplete/failed tasks from a persisted swarm run",
].join("\n  ");

function resolveCommandOptions(
	storeOrOptions?: SwarmRunStore | ApplyOrchestratorCommandOptions,
): ApplyOrchestratorCommandOptions {
	if (!storeOrOptions) return {};
	if (storeOrOptions instanceof SwarmRunStore) {
		return { store: storeOrOptions };
	}
	return storeOrOptions;
}

async function formatPersistedRunsList(store?: SwarmRunStore): Promise<string> {
	const runStore = store ?? new SwarmRunStore();
	const runs = await runStore.listRuns(10);
	if (runs.length === 0) {
		return "No persisted swarm runs found.";
	}
	const lines = runs.map(run => {
		const updated = new Date(run.updatedAt).toISOString();
		return `${run.planId}  [${run.status}]  ${run.completedTasks}/${run.totalTasks} tasks  ${updated}  — ${run.goal}`;
	});
	return `Recent swarm runs (${runs.length}):\n  ${lines.join("\n  ")}`;
}

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
	storeOrOptions?: SwarmRunStore | ApplyOrchestratorCommandOptions,
): Promise<string> {
	const options = resolveCommandOptions(storeOrOptions);
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
			return describeOrchestratorMode(settings, options.platformContext);
		case "mode": {
			const value = rest[0]?.toLowerCase();
			if (value !== "auto" && value !== "single" && value !== "parallel") {
				return "Usage: /swarm mode <auto|single|parallel> (alias: /orchestrate mode <auto|single|parallel>)";
			}
			cfgOrchestratorMode.set(settings, value);
			return `Fan-out policy set to ${value}.`;
		}
		case "workers": {
			const raw = rest[0];
			const workers = Number(raw);
			if (!raw || !Number.isSafeInteger(workers) || workers < 1 || workers > MAX_ORCHESTRATOR_WORKERS) {
				return `Usage: /swarm workers <positive integer 1..${MAX_ORCHESTRATOR_WORKERS}>`;
			}
			cfgOrchestratorMaxConcurrency.set(settings, workers);
			return `Concurrent workers capped at ${workers}.`;
		}
		case "runs":
		case "list":
			return formatPersistedRunsList(options.store);
		default:
			return `Unknown /swarm subcommand "${verb}" (alias: /orchestrate).\n  ${ORCHESTRATOR_USAGE}`;
	}
}
