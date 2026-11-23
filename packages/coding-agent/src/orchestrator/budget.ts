/**
 * Run budgets.
 *
 * Bounds one orchestration run on tokens, requests, and wall-clock time. When
 * a limit is hit the engine stops scheduling new workers and cancels the rest
 * with reason "budget", so a runaway plan can never spend past its ceiling.
 *
 * The limits are initial defaults (UNVERIFIED); the benchmark milestone tunes
 * them. Design reference: ORCHESTRATOR_DESIGN.md section 8.
 */

import type { UsageTotals, WorkerUsage } from "./types";

export interface BudgetLimits {
	/** Total tokens (all categories summed) before the run is stopped. */
	readonly maxTokens?: number;
	/** Provider requests before the run is stopped. */
	readonly maxRequests?: number;
	/** Wall-clock milliseconds before the run is stopped. */
	readonly maxWallClockMs?: number;
}

export interface BudgetOptions extends BudgetLimits {
	readonly now?: () => number;
}

interface ResolvedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly requests: number;
}

/** `0`, negative, or non-finite limits mean "unlimited" (undefined). */
function positiveOrUndefined(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (!Number.isFinite(num)) return undefined;
	const n = Math.trunc(num);
	return n > 0 ? n : undefined;
}

function resolveUsage(usage: WorkerUsage): ResolvedUsage {
	const inputTokens = usage.inputTokens ?? 0;
	const outputTokens = usage.outputTokens ?? 0;
	const reasoningTokens = usage.reasoningTokens ?? 0;
	const cacheReadTokens = usage.cacheReadTokens ?? 0;
	const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
	const componentSum = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
	const totalTokens = usage.totalTokens ?? componentSum;
	const requests = usage.requests ?? 0;
	return {
		inputTokens,
		outputTokens,
		reasoningTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		requests,
	};
}

function hasAnyUsageField(usage: WorkerUsage): boolean {
	return (
		usage.inputTokens !== undefined ||
		usage.outputTokens !== undefined ||
		usage.reasoningTokens !== undefined ||
		usage.cacheReadTokens !== undefined ||
		usage.cacheWriteTokens !== undefined ||
		usage.totalTokens !== undefined ||
		usage.requests !== undefined
	);
}

export class BudgetGuard {
	readonly #limits: BudgetLimits;
	readonly #now: () => number;
	readonly #startedAt: number;
	readonly #interim = new Map<string, ResolvedUsage>();
	#inputTokens = 0;
	#outputTokens = 0;
	#reasoningTokens = 0;
	#cacheReadTokens = 0;
	#cacheWriteTokens = 0;
	#totalTokens = 0;
	#requests = 0;
	#exhaustedReason: string | undefined;

	constructor(options: BudgetOptions = {}) {
		// The settings document `0` as "unlimited"; normalize it to `undefined`
		// so a zero limit never fires.
		this.#limits = {
			maxTokens: positiveOrUndefined(options.maxTokens),
			maxRequests: positiveOrUndefined(options.maxRequests),
			maxWallClockMs: positiveOrUndefined(options.maxWallClockMs),
		};
		this.#now = options.now ?? (() => Date.now());
		this.#startedAt = this.#now();
	}

	/**
	 * Record latest in-flight usage for an active worker/task key.
	 * Replaces any prior interim snapshot for `workerKey` (delta-safe) and
	 * immediately re-evaluates budget limits so mid-flight exhaustion is caught.
	 */
	recordInterimUsage(workerKey: string, usage: WorkerUsage): void {
		this.#interim.set(workerKey, resolveUsage(usage));
		this.#refreshLimits();
	}

	/** Account one finished worker run (replacing any interim usage for `workerKey`). */
	charge(usage: WorkerUsage, workerKey?: string): void {
		const priorInterim = workerKey !== undefined ? this.#interim.get(workerKey) : undefined;
		if (workerKey !== undefined) {
			this.#interim.delete(workerKey);
		}
		const resolved = !hasAnyUsageField(usage) && priorInterim !== undefined ? priorInterim : resolveUsage(usage);
		this.#inputTokens += resolved.inputTokens;
		this.#outputTokens += resolved.outputTokens;
		this.#reasoningTokens += resolved.reasoningTokens;
		this.#cacheReadTokens += resolved.cacheReadTokens;
		this.#cacheWriteTokens += resolved.cacheWriteTokens;
		this.#totalTokens += resolved.totalTokens;
		this.#requests += resolved.requests;
		this.#refreshLimits();
	}

	/** Re-evaluate the limits; cheap enough to call between worker starts. */
	refresh(): void {
		this.#refreshLimits();
	}

	/** Remaining wall-clock milliseconds before exhaustion, or undefined when unbounded. */
	remainingWallClockMs(): number | undefined {
		if (this.#limits.maxWallClockMs === undefined) return undefined;
		const elapsed = this.#now() - this.#startedAt;
		return Math.max(0, this.#limits.maxWallClockMs - elapsed);
	}

	get exhausted(): boolean {
		return this.#exhaustedReason !== undefined;
	}

	/** Why the budget stopped the run, if it did. */
	get reason(): string | undefined {
		return this.#exhaustedReason;
	}

	snapshot(): UsageTotals {
		let inputTokens = this.#inputTokens;
		let outputTokens = this.#outputTokens;
		let reasoningTokens = this.#reasoningTokens;
		let cacheReadTokens = this.#cacheReadTokens;
		let cacheWriteTokens = this.#cacheWriteTokens;
		let totalTokens = this.#totalTokens;
		let requests = this.#requests;

		for (const interim of this.#interim.values()) {
			inputTokens += interim.inputTokens;
			outputTokens += interim.outputTokens;
			reasoningTokens += interim.reasoningTokens;
			cacheReadTokens += interim.cacheReadTokens;
			cacheWriteTokens += interim.cacheWriteTokens;
			totalTokens += interim.totalTokens;
			requests += interim.requests;
		}

		return {
			inputTokens,
			outputTokens,
			reasoningTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens,
			requests,
			wallClockMs: this.#now() - this.#startedAt,
		};
	}

	#refreshLimits(): void {
		if (this.#exhaustedReason !== undefined) return;
		const usage = this.snapshot();
		if (this.#limits.maxTokens !== undefined && usage.totalTokens >= this.#limits.maxTokens) {
			const op = usage.totalTokens > this.#limits.maxTokens ? ">" : ">=";
			this.#exhaustedReason = `token budget exceeded (${usage.totalTokens} ${op} ${this.#limits.maxTokens})`;
			return;
		}
		if (this.#limits.maxRequests !== undefined && usage.requests >= this.#limits.maxRequests) {
			const op = usage.requests > this.#limits.maxRequests ? ">" : ">=";
			this.#exhaustedReason = `request budget exceeded (${usage.requests} ${op} ${this.#limits.maxRequests})`;
			return;
		}
		if (this.#limits.maxWallClockMs !== undefined && usage.wallClockMs >= this.#limits.maxWallClockMs) {
			const op = usage.wallClockMs > this.#limits.maxWallClockMs ? ">" : ">=";
			this.#exhaustedReason = `wall-clock budget exceeded (${usage.wallClockMs} ${op} ${this.#limits.maxWallClockMs})`;
		}
	}
}
