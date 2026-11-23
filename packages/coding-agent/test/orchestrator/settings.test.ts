/**
 * Orchestrator settings contracts:
 * - the feature is OFF by default, so the single-agent path is unchanged
 * - fan-out mode, retries, trust gate, conflict resolution, and budget knobs have documented defaults
 * - resolveOrchestratorVerificationChecks numbers surviving checks sequentially after filtering blanks
 * - resolveOrchestratorBudget guards against non-finite values
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	cfgOrchestratorAllowProjectVerificationChecks,
	cfgOrchestratorConflictResolution,
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMaxRequests,
	cfgOrchestratorMaxRetries,
	cfgOrchestratorMaxTokens,
	cfgOrchestratorMaxWallClockMs,
	cfgOrchestratorMode,
	cfgOrchestratorTouchPoints,
	cfgOrchestratorVerificationChecks,
	resolveOrchestratorBudget,
	resolveOrchestratorVerificationChecks,
} from "../../src/orchestrator/settings";

describe("orchestrator settings", () => {
	test("is disabled by default and untrusted project checks are off by default", () => {
		const settings = Settings.isolated({});
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
		expect(cfgOrchestratorAllowProjectVerificationChecks.get(settings)).toBe(false);
	});

	test("defaults to auto mode, 1 retry, integrator-agent conflict resolution, and initial thresholds", () => {
		const settings = Settings.isolated({});
		expect(cfgOrchestratorMode.get(settings)).toBe("auto");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(4);
		expect(cfgOrchestratorTouchPoints.get(settings)).toBe(4);
		expect(cfgOrchestratorMaxTokens.get(settings)).toBe(0);
		expect(cfgOrchestratorMaxRetries.get(settings)).toBe(1);
		expect(cfgOrchestratorConflictResolution.get(settings)).toBe("integrator-agent");
	});

	test("honors overrides through the settings scope", () => {
		const settings = Settings.isolated({
			"orchestrator.enabled": true,
			"orchestrator.mode": "single",
			"orchestrator.maxConcurrency": 2,
			"orchestrator.touchPoints": 8,
			"orchestrator.maxRetries": 3,
			"orchestrator.allowProjectVerificationChecks": true,
			"orchestrator.conflictResolution": "none",
		});
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(cfgOrchestratorMode.get(settings)).toBe("single");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(2);
		expect(cfgOrchestratorTouchPoints.get(settings)).toBe(8);
		expect(cfgOrchestratorMaxRetries.get(settings)).toBe(3);
		expect(cfgOrchestratorAllowProjectVerificationChecks.get(settings)).toBe(true);
		expect(cfgOrchestratorConflictResolution.get(settings)).toBe("none");
	});

	test("numbers surviving verification checks sequentially after filtering blank entries", () => {
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["  ", "bun check", "", "bun test"]);
		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([
			{ id: "check-1", command: "bun check" },
			{ id: "check-2", command: "bun test" },
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("resolveOrchestratorBudget treats non-finite and non-positive values as unlimited", () => {
		const settings = Settings.isolated({});
		vi.spyOn(cfgOrchestratorMaxTokens, "get").mockReturnValue(Number.POSITIVE_INFINITY);
		vi.spyOn(cfgOrchestratorMaxRequests, "get").mockReturnValue(Number.NaN);
		vi.spyOn(cfgOrchestratorMaxWallClockMs, "get").mockReturnValue(-100);
		expect(resolveOrchestratorBudget(settings)).toEqual({
			maxTokens: undefined,
			maxRequests: undefined,
			maxWallClockMs: undefined,
		});
	});
});
