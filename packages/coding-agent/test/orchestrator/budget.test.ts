/**
 * Budget contracts:
 * - charging accumulates all usage categories and computes totalTokens when omitted
 * - reaching 100% (`>=`) of a token, request, or wall-clock limit exhausts the budget
 * - interim usage updates (`recordInterimUsage`) trigger mid-flight exhaustion without double-counting on settlement
 * - a zero/absent limit never fires
 */

import { describe, expect, test } from "bun:test";
import { BudgetGuard } from "../../src/orchestrator/budget";

describe("BudgetGuard", () => {
	test("accumulates token and request usage and falls back to summed categories when totalTokens is omitted", () => {
		const budget = new BudgetGuard({ maxTokens: 1000 });
		budget.charge({
			inputTokens: 10,
			outputTokens: 5,
			reasoningTokens: 2,
			cacheReadTokens: 3,
			cacheWriteTokens: 1,
			requests: 2,
		});
		budget.charge({ totalTokens: 7, requests: 1 });
		const usage = budget.snapshot();
		expect(usage.inputTokens).toBe(10);
		expect(usage.outputTokens).toBe(5);
		expect(usage.reasoningTokens).toBe(2);
		expect(usage.cacheReadTokens).toBe(3);
		expect(usage.cacheWriteTokens).toBe(1);
		expect(usage.totalTokens).toBe(28);
		expect(usage.requests).toBe(3);
		expect(budget.exhausted).toBe(false);
	});

	test("token limit fires at 100% (>= maxTokens)", () => {
		const budget = new BudgetGuard({ maxTokens: 100 });
		budget.charge({ inputTokens: 60, outputTokens: 39, requests: 1 });
		expect(budget.exhausted).toBe(false);
		budget.charge({ outputTokens: 1, requests: 1 });
		expect(budget.exhausted).toBe(true);
		expect(budget.reason).toContain("token budget exceeded");
	});

	test("request limit fires independently at 100% (>= maxRequests)", () => {
		const budget = new BudgetGuard({ maxRequests: 2 });
		budget.charge({ requests: 1, totalTokens: 0 });
		expect(budget.exhausted).toBe(false);
		budget.charge({ requests: 1, totalTokens: 0 });
		expect(budget.exhausted).toBe(true);
		expect(budget.reason).toContain("request budget exceeded");
	});

	test("recordInterimUsage triggers mid-flight exhaustion and settles without double-counting", () => {
		const budget = new BudgetGuard({ maxTokens: 100 });
		budget.recordInterimUsage("t1", { inputTokens: 40, outputTokens: 20 });
		expect(budget.snapshot().totalTokens).toBe(60);
		expect(budget.exhausted).toBe(false);

		// Updated interim snapshot for t1 plus t2 crosses 100.
		budget.recordInterimUsage("t1", { inputTokens: 45, outputTokens: 25 });
		budget.recordInterimUsage("t2", { totalTokens: 30 });
		expect(budget.snapshot().totalTokens).toBe(100);
		expect(budget.exhausted).toBe(true);

		// Settling t1 replaces its interim 70 with final 75 (total = 75 + 30 = 105).
		budget.charge({ totalTokens: 75 }, "t1");
		expect(budget.snapshot().totalTokens).toBe(105);
	});

	test("wall-clock limit uses the injected clock", () => {
		let now = 0;
		const budget = new BudgetGuard({ maxWallClockMs: 1000, now: () => now });
		expect(budget.remainingWallClockMs()).toBe(1000);
		now = 1000;
		expect(budget.exhausted).toBe(false); // only re-evaluated on charge or refresh
		budget.refresh();
		expect(budget.exhausted).toBe(true);
		expect(budget.reason).toContain("wall-clock budget exceeded");
	});

	test("no limits means never exhausted", () => {
		const budget = new BudgetGuard({});
		budget.charge({ totalTokens: 10_000_000, requests: 10_000 });
		budget.refresh();
		expect(budget.exhausted).toBe(false);
	});

	test("a zero limit means unlimited, matching the settings documentation", () => {
		const budget = new BudgetGuard({ maxTokens: 0, maxRequests: 0, maxWallClockMs: 0 });
		budget.charge({ totalTokens: 5_000_000, requests: 5_000 });
		budget.refresh();
		expect(budget.exhausted).toBe(false);
	});

	test("exhaustion is sticky and keeps its first reason", () => {
		const budget = new BudgetGuard({ maxTokens: 10 });
		budget.charge({ totalTokens: 50 });
		budget.charge({ totalTokens: 100 });
		expect(budget.reason).toContain("50 > 10");
	});
});
