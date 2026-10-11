/**
 * Fan-out router.
 *
 * Decides whether a plan runs as a single agent or as multiple workers. Mars
 * is positioned on speed, so the default answer is "single": fan-out is
 * reserved for work whose subtasks touch enough distinct files to pay for the
 * coordination overhead.
 *
 * The thresholds below are initial defaults (UNVERIFIED). They exist so the
 * benchmark milestone can tune them from measurements instead of guesses.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md section 6.
 */

/** Tunable routing thresholds. */
export interface RouterThresholds {
	/** Minimum distinct declared write targets before fan-out is considered. */
	readonly touchPoints: number;
	/** Minimum distinct modules among the targets. */
	readonly minModules: number;
	/** Minimum number of mutually independent tasks. */
	readonly minIndependentTasks: number;
	/** Minimum estimated task weight (ms) before fan-out is considered. */
	readonly minEstimatedRuntimeMs: number;
}

/** Initial defaults; tune with the Section 12 benchmark, do not treat as measured values. */
export const DEFAULT_ROUTER_THRESHOLDS: RouterThresholds = {
	touchPoints: 4,
	minModules: 2,
	minIndependentTasks: 2,
	minEstimatedRuntimeMs: 60_000,
};

/** Platform target for platform-aware routing. */
export type RouterPlatform = "desktop" | "android";

/** What the router looks at. */
export interface FanOutSignals {
	readonly taskCount: number;
	/** Tasks with no dependency on any sibling (can run concurrently). */
	readonly independentTaskCount: number;
	/** Distinct declared write targets across all tasks. */
	readonly fileTargets: number;
	/** Distinct top-level directories among the targets. */
	readonly moduleCount: number;
	readonly platform: RouterPlatform;
	/** Estimated wall-clock weight of the whole plan. */
	readonly estimatedRuntimeMs: number;
}

/** Router decision plus the reason, so the UI and logs can explain it. */
export interface RouterDecision {
	readonly fanOut: boolean;
	readonly reason: string;
	/** Signals that failed the multi-agent gate (empty when fanning out). */
	readonly unmet: readonly string[];
}

/** Manual override for the router, from the `orchestrator.mode` setting. */
export type RouterMode = "auto" | "single" | "parallel";

export interface RouterOptions {
	readonly thresholds?: RouterThresholds;
	readonly mode?: RouterMode;
}

/** Top-level directory of a repo-relative path, used for the module count. */
export function moduleOf(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
	const firstSlash = normalized.indexOf("/");
	return firstSlash > 0 ? normalized.slice(0, firstSlash) : normalized;
}

/** Distinct top-level directories among the given paths. */
export function countModules(paths: readonly string[]): number {
	return new Set(paths.map(moduleOf)).size;
}

/**
 * Decide single-agent vs multi-agent.
 *
 * `parallel` forces fan-out whenever the plan has at least two independent
 * tasks; `single` never fans out; `auto` applies the threshold gate. Android
 * uses the same gate as desktop in this milestone; its lower concurrency
 * default is applied by the engine from settings.
 */
export function decideFanOut(signals: FanOutSignals, options: RouterOptions = {}): RouterDecision {
	const thresholds = options.thresholds ?? DEFAULT_ROUTER_THRESHOLDS;
	const mode = options.mode ?? "auto";
	if (mode === "single") {
		return { fanOut: false, reason: "orchestrator.mode is single", unmet: [] };
	}
	if (signals.taskCount < 2 || signals.independentTaskCount < 2) {
		return {
			fanOut: false,
			reason: "fewer than two independent tasks",
			unmet: ["independentTaskCount"],
		};
	}
	if (mode === "parallel") {
		return { fanOut: true, reason: "orchestrator.mode is parallel", unmet: [] };
	}
	const unmet: string[] = [];
	if (signals.fileTargets < thresholds.touchPoints) unmet.push("fileTargets");
	if (signals.moduleCount < thresholds.minModules) unmet.push("moduleCount");
	if (signals.independentTaskCount < thresholds.minIndependentTasks) unmet.push("independentTaskCount");
	if (signals.estimatedRuntimeMs < thresholds.minEstimatedRuntimeMs) unmet.push("estimatedRuntimeMs");
	if (unmet.length > 0) {
		return {
			fanOut: false,
			reason: `below fan-out thresholds (initial defaults): ${unmet.join(", ")}`,
			unmet,
		};
	}
	return { fanOut: true, reason: "independent work across enough modules to pay for coordination", unmet: [] };
}
