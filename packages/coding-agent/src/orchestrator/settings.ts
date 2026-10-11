/**
 * Settings declared by the orchestrator domain (see `config/registry.ts`).
 * Declaration order is the settings-panel order; `config/all-settings.ts`
 * registers every domain.
 *
 * The orchestrator is OFF by default: with `orchestrator.enabled` false the
 * engine is never constructed and behavior is identical to a build without it.
 */

import { register } from "../config/registry";
import { isAndroid } from "@marsai-org/utils/platform";
import type { Settings } from "../config/settings";

/** Desktop initial default for concurrent workers (to be tuned by the benchmark). */
export const ORCHESTRATOR_DEFAULT_CONCURRENCY_DESKTOP = 4;

/** Mobile initial default for concurrent workers (to be tuned by the benchmark). */
export const ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID = 2;

/** Initial default cap on the total child process tree on Android (to be tuned by the benchmark). */
export const ORCHESTRATOR_ANDROID_PROCESS_CAP = 6;

/** Master switch for the orchestrator. Off by default (single agent stays the default path). */
export const cfgOrchestratorEnabled = register({
	id: "orchestrator.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Enable Multi-Agent Orchestrator",
		description:
			"Coordinate multiple worker agents for large independent tasks. Off keeps every session on the default single-agent path.",
	},
});

/** Fan-out policy. `auto` applies the router thresholds; `single` and `parallel` override them. */
export const cfgOrchestratorMode = register({
	id: "orchestrator.mode",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["auto", "single", "parallel"] as const,
	default: "auto",
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Fan-Out Mode",
		description:
			"auto decides from task signals (default thresholds keep small work on one agent), single never fans out, parallel fans out whenever two independent tasks exist",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Router decides; small and coupled work stays on a single agent",
			},
			{ value: "single", label: "Single", description: "Never fan out" },
			{ value: "parallel", label: "Parallel", description: "Fan out whenever two independent tasks exist" },
		],
	},
});

/** Maximum workers allowed to run at once. Initial default; tuned by the benchmark. */
export const cfgOrchestratorMaxConcurrency = register({
	id: "orchestrator.maxConcurrency",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 4,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Max Concurrent Workers",
		description:
			"Maximum number of orchestrator workers running at the same time (Android/Termux caps the effective value at 2)",
		options: [
			{ value: "1", label: "1 worker" },
			{ value: "2", label: "2 workers" },
			{ value: "4", label: "4 workers" },
			{ value: "8", label: "8 workers" },
			{ value: "16", label: "16 workers" },
		],
	},
});

/** Initial default cap on the total child process tree on Android; other platforms are unbounded by this knob. */
export const cfgOrchestratorAndroidProcessCap = register({
	id: "orchestrator.androidProcessCap",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: ORCHESTRATOR_ANDROID_PROCESS_CAP,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Android Process Cap",
		description:
			"Total child processes an orchestration run may create on Android/Termux (parent host + workers + their tool children); protects against background-process reaping",
		options: [
			{ value: "4", label: "4 processes" },
			{ value: "6", label: "6 processes" },
			{ value: "8", label: "8 processes" },
		],
	},
});

/** Declared write targets required before the router considers fan-out. Initial default. */
export const cfgOrchestratorTouchPoints = register({
	id: "orchestrator.touchPoints",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 4,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Fan-Out Touch Points",
		description:
			"Distinct declared write targets the router wants before it fans out (initial default, tuned by benchmark)",
		options: [
			{ value: "2", label: "2 files" },
			{ value: "4", label: "4 files" },
			{ value: "8", label: "8 files" },
		],
	},
});

/** Total-token budget for one run. 0 disables the limit. Initial default. */
export const cfgOrchestratorMaxTokens = register({
	id: "orchestrator.maxTokens",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Token Budget",
		description: "Total tokens one orchestration run may consume; 0 means unlimited",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "250000", label: "250k tokens" },
			{ value: "500000", label: "500k tokens" },
			{ value: "1000000", label: "1M tokens" },
		],
	},
});

/** Request budget for one run. 0 disables the limit. Initial default. */
export const cfgOrchestratorMaxRequests = register({
	id: "orchestrator.maxRequests",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Request Budget",
		description: "Provider requests one orchestration run may issue; 0 means unlimited",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "50", label: "50 requests" },
			{ value: "200", label: "200 requests" },
		],
	},
});

/** Wall-clock budget for one run in milliseconds. 0 disables the limit. Initial default. */
export const cfgOrchestratorMaxWallClockMs = register({
	id: "orchestrator.maxWallClockMs",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Orchestrator",
		label: "Wall-Clock Budget",
		description: "Wall-clock milliseconds one orchestration run may take; 0 means unlimited",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "300000", label: "5 minutes" },
			{ value: "900000", label: "15 minutes" },
			{ value: "3600000", label: "1 hour" },
		],
	},
});

/**
 * Effective orchestration limits for the current platform.
 *
 * `concurrency` is the configured worker cap, narrowed to the mobile initial
 * default on Android/Termux. `processCap` bounds the total child process tree
 * on Android/Termux (parent host + workers + their tool children) and is
 * `undefined` elsewhere. Both are conservative defaults (UNVERIFIED) tuned by
 * the benchmark milestone.
 */
export interface OrchestratorLimits {
	readonly concurrency: number;
	readonly processCap: number | undefined;
}

/** Read the configured limits and apply the platform-aware narrowing. */
export function resolveOrchestratorLimits(settings: Settings): OrchestratorLimits {
	const configured = Math.max(1, Math.trunc(Number(cfgOrchestratorMaxConcurrency.get(settings)) || 1));
	if (!isAndroid()) return { concurrency: configured, processCap: undefined };
	return {
		concurrency: Math.min(configured, ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID),
		processCap: Math.max(1, Math.trunc(Number(cfgOrchestratorAndroidProcessCap.get(settings)) || 1)),
	};
}

/**
 * Effective worker concurrency for the current platform: the configured value,
 * narrowed to the mobile initial default on Android/Termux and never widened.
 */
export function resolveOrchestratorConcurrency(settings: Settings): number {
	return resolveOrchestratorLimits(settings).concurrency;
}

/**
 * Normalize a configured budget into engine limits: the settings document `0`
 * as "unlimited", which the engine expresses as `undefined`.
 */
export function resolveOrchestratorBudget(settings: Settings): {
	maxTokens: number | undefined;
	maxRequests: number | undefined;
	maxWallClockMs: number | undefined;
} {
	const positive = (value: unknown): number | undefined => {
		const n = Math.trunc(Number(value) || 0);
		return n > 0 ? n : undefined;
	};
	return {
		maxTokens: positive(cfgOrchestratorMaxTokens.get(settings)),
		maxRequests: positive(cfgOrchestratorMaxRequests.get(settings)),
		maxWallClockMs: positive(cfgOrchestratorMaxWallClockMs.get(settings)),
	};
}
