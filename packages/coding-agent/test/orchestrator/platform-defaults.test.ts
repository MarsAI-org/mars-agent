/**
 * Platform-aware orchestrator defaults:
 * - on non-Android platforms the configured value is used unchanged
 * - on Android/Termux the effective value is capped at the mobile default
 * - the cap only narrows, never widens
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	ORCHESTRATOR_ANDROID_PROCESS_CAP,
	ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID,
	ORCHESTRATOR_DEFAULT_CONCURRENCY_DESKTOP,
	resolveOrchestratorConcurrency,
} from "../../src/orchestrator/settings";

describe("resolveOrchestratorConcurrency", () => {
	test("keeps the configured value on non-Android platforms", () => {
		const settings = Settings.isolated({ "orchestrator.maxConcurrency": 8 });
		// This test environment is not Android, so the value passes through.
		const expected = process.platform === "android" ? ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID : 8;
		expect(resolveOrchestratorConcurrency(settings, 8)).toBe(expected);
	});

	test("documents the desktop and Android initial defaults", () => {
		expect(ORCHESTRATOR_DEFAULT_CONCURRENCY_DESKTOP).toBe(4);
		expect(ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID).toBe(2);
		expect(ORCHESTRATOR_ANDROID_PROCESS_CAP).toBe(6);
	});
});
