/**
 * Platform self-check contracts:
 * - the report reflects the environment it is given
 * - shared-storage placement is flagged so config never lands on /sdcard
 * - JSON output is machine-parseable
 */

import { describe, expect, test } from "bun:test";
import { buildPlatformCheckReport, isOnSharedStorage } from "../src/platform-check";

describe("buildPlatformCheckReport", () => {
	test("reports the runtime platform facts", () => {
		const report = buildPlatformCheckReport();
		expect(report.command).toBe("platform-check");
		expect(report.platform.reportedPlatform).toBe(process.platform);
		expect(report.platform.arch).toBe(process.arch);
		expect(typeof report.platform.bunVersion).toBe("string");
		expect(report.paths.configRoot.length).toBeGreaterThan(0);
		expect(report.paths.home.length).toBeGreaterThan(0);
	});

	test("never reports config on shared storage in a normal layout", () => {
		const report = buildPlatformCheckReport();
		expect(report.paths.onSharedStorage).toBe(false);
	});

	test("flags shared-storage placement for Android shared roots", () => {
		expect(isOnSharedStorage("/sdcard/mars")).toBe(true);
		expect(isOnSharedStorage("/storage/emulated/0/mars")).toBe(true);
		expect(isOnSharedStorage("/data/data/com.termux/files/home/mars")).toBe(false);
	});
});
