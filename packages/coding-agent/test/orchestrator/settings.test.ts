/**
 * Orchestrator settings contracts:
 * - the feature is OFF by default, so the single-agent path is unchanged
 * - fan-out mode and budget knobs have their documented defaults
 * - knobs are overridable through the settings scope
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMaxTokens,
	cfgOrchestratorMode,
	cfgOrchestratorTouchPoints,
} from "../../src/orchestrator/settings";

describe("orchestrator settings", () => {
	test("is disabled by default", () => {
		const settings = Settings.isolated({});
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
	});

	test("defaults to auto mode and the documented initial thresholds", () => {
		const settings = Settings.isolated({});
		expect(cfgOrchestratorMode.get(settings)).toBe("auto");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(4);
		expect(cfgOrchestratorTouchPoints.get(settings)).toBe(4);
		expect(cfgOrchestratorMaxTokens.get(settings)).toBe(0);
	});

	test("honors overrides through the settings scope", () => {
		const settings = Settings.isolated({
			"orchestrator.enabled": true,
			"orchestrator.mode": "single",
			"orchestrator.maxConcurrency": 2,
			"orchestrator.touchPoints": 8,
		});
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(cfgOrchestratorMode.get(settings)).toBe("single");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(2);
		expect(cfgOrchestratorTouchPoints.get(settings)).toBe(8);
	});
});
