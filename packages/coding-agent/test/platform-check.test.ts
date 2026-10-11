/**
 * Platform self-check contracts:
 * - the report mirrors the environment it is given (Termux, LD_PRELOAD, arch)
 * - shared-storage detection respects path boundaries, so `/sdcard2` is not
 *   mistaken for `/sdcard`
 */

import { describe, expect, test } from "bun:test";
import { buildPlatformCheckReport, isOnSharedStorage } from "../src/platform-check";

describe("isOnSharedStorage", () => {
	test("flags Android shared roots and their children", () => {
		expect(isOnSharedStorage("/sdcard/mars")).toBe(true);
		expect(isOnSharedStorage("/storage/emulated/0/mars")).toBe(true);
		expect(isOnSharedStorage("/mnt/sdcard")).toBe(true);
	});

	test("does not flag lookalike siblings or the Termux home", () => {
		expect(isOnSharedStorage("/sdcard2/mars")).toBe(false);
		expect(isOnSharedStorage("/mnt/sdcardX")).toBe(false);
		expect(isOnSharedStorage("/data/data/com.termux/files/home/mars")).toBe(false);
	});
});

describe("buildPlatformCheckReport", () => {
	test("mirrors the injected Termux environment", () => {
		const report = buildPlatformCheckReport({
			env: {
				PREFIX: "/data/data/com.termux/files/usr",
				LD_PRELOAD: "/system/lib/libtermux-exec.so",
			},
			platform: "linux",
			arch: "arm64",
		});
		expect(report.platform.isTermux).toBe(true);
		expect(report.platform.isAndroid).toBe(true);
		expect(report.platform.termuxPrefix).toBe("/data/data/com.termux/files/usr");
		// The injected Termux shim is what the Tier-1 launcher must clear.
		expect(report.runtime.injectedLdPreload).toBe(true);
	});

	test("reports a desktop environment without the Termux markers", () => {
		const report = buildPlatformCheckReport({
			env: { PATH: "/usr/bin:/bin" },
			platform: "linux",
			arch: "x64",
		});
		expect(report.platform.isTermux).toBe(false);
		expect(report.platform.isAndroid).toBe(false);
		expect(report.runtime.injectedLdPreload).toBe(false);
		expect(report.paths.onSharedStorage).toBe(false);
	});
});
