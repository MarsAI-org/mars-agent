/**
 * Budget contracts:
 * - charging accumulates all usage categories
 * - each limit stops the run independently, with a reason naming the limit
 * - a zero/absent limit never fires
 */

import { describe, expect, test } from "bun:test";
import { BudgetGuard } from "../../src/orchestrator/budget";

describe("BudgetGuard", () => {
	test("accumulates token and request usage", () => {
		const budget = new BudgetGuard({ maxTokens: 1000 });
		budget.charge({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, totalTokens: 18, requests: 2 });
		budget.charge({ totalTokens: 7, requests: 1 });
		const usage = budget.snapshot();
		expect(usage.inputTokens).toBe(10);
		expect(usage.outputTokens).toBe(5);
		expect(usage.cacheReadTokens).toBe(3);
		expect(usage.totalTokens).toBe(25);
		expect(usage.requests).toBe(3);
		expect(budget.exhausted).toBe(false);
	});

	test("token limit fires once exceeded", () => {
		const budget = new BudgetGuard({ maxTokens: 100 });
		budget.charge({ totalTokens: 101, requests: 1 });
		expect(budget.exhausted).toBe(true);
		expect(budget.reason).toContain("token budget exceeded");
	});

	test("request limit fires independently", () => {
		const budget = new BudgetGuard({ maxRequests: 2 });
		budget.charge({ requests: 2, totalTokens: 0 });
		expect(budget.exhausted).toBe(false);
		budget.charge({ requests: 1 });
		expect(budget.exhausted).toBe(true);
		expect(budget.reason).toContain("request budget exceeded");
	});

	test("wall-clock limit uses the injected clock", () => {
		let now = 0;
		const budget = new BudgetGuard({ maxWallClockMs: 1000, now: () => now });
		now = 1001;
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

	test("exhaustion is sticky and keeps its first reason", () => {
		const budget = new BudgetGuard({ maxTokens: 10 });
		budget.charge({ totalTokens: 50 });
		budget.charge({ totalTokens: 100 });
		expect(budget.reason).toContain("50 > 10");
	});
});
