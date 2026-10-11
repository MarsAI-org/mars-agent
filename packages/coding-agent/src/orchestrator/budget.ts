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

export class BudgetGuard {
	readonly #limits: BudgetLimits;
	readonly #now: () => number;
	readonly #startedAt: number;
	#inputTokens = 0;
	#outputTokens = 0;
	#reasoningTokens = 0;
	#cacheReadTokens = 0;
	#cacheWriteTokens = 0;
	#totalTokens = 0;
	#requests = 0;
	#exhaustedReason: string | undefined;

	constructor(options: BudgetOptions = {}) {
		this.#limits = {
			maxTokens: options.maxTokens,
			maxRequests: options.maxRequests,
			maxWallClockMs: options.maxWallClockMs,
		};
		this.#now = options.now ?? (() => Date.now());
		this.#startedAt = this.#now();
	}

	/** Account one finished worker run. */
	charge(usage: WorkerUsage): void {
		this.#inputTokens += usage.inputTokens ?? 0;
		this.#outputTokens += usage.outputTokens ?? 0;
		this.#reasoningTokens += usage.reasoningTokens ?? 0;
		this.#cacheReadTokens += usage.cacheReadTokens ?? 0;
		this.#cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		this.#totalTokens += usage.totalTokens ?? 0;
		this.#requests += usage.requests ?? 0;
		this.#refreshWallClock();
	}

	/** Re-evaluate the limits; cheap enough to call between worker starts. */
	refresh(): void {
		this.#refreshWallClock();
	}

	get exhausted(): boolean {
		return this.#exhaustedReason !== undefined;
	}

	/** Why the budget stopped the run, if it did. */
	get reason(): string | undefined {
		return this.#exhaustedReason;
	}

	snapshot(): UsageTotals {
		return {
			inputTokens: this.#inputTokens,
			outputTokens: this.#outputTokens,
			reasoningTokens: this.#reasoningTokens,
			cacheReadTokens: this.#cacheReadTokens,
			cacheWriteTokens: this.#cacheWriteTokens,
			totalTokens: this.#totalTokens,
			requests: this.#requests,
			wallClockMs: this.#now() - this.#startedAt,
		};
	}

	#refreshWallClock(): void {
		if (this.#exhaustedReason !== undefined) return;
		const usage = this.snapshot();
		if (this.#limits.maxTokens !== undefined && usage.totalTokens > this.#limits.maxTokens) {
			this.#exhaustedReason = `token budget exceeded (${usage.totalTokens} > ${this.#limits.maxTokens})`;
			return;
		}
		if (this.#limits.maxRequests !== undefined && usage.requests > this.#limits.maxRequests) {
			this.#exhaustedReason = `request budget exceeded (${usage.requests} > ${this.#limits.maxRequests})`;
			return;
		}
		if (this.#limits.maxWallClockMs !== undefined && usage.wallClockMs > this.#limits.maxWallClockMs) {
			this.#exhaustedReason = `wall-clock budget exceeded (${usage.wallClockMs} > ${this.#limits.maxWallClockMs})`;
		}
	}
}
