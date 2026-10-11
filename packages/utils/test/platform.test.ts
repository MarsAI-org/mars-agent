import { describe, expect, test } from "bun:test";
import { getPlatformSummary, isAndroid, isArm64, isTermux } from "../src/platform";

describe("platform detection", () => {
	test("detects Termux by PREFIX containing com.termux", () => {
		expect(isTermux({ env: { PREFIX: "/data/data/com.termux/files/usr" } })).toBe(true);
	});

	test("detects Termux by TERMUX_VERSION", () => {
		expect(isTermux({ env: { TERMUX_VERSION: "0.118.0" } })).toBe(true);
	});

	test("does not report Termux in standard Linux environment", () => {
		expect(isTermux({ env: { PATH: "/usr/bin:/bin" } })).toBe(false);
	});

	test("identifies Android when running inside Termux", () => {
		expect(isAndroid({ env: { PREFIX: "/data/data/com.termux/files/usr" } })).toBe(true);
	});

	test("identifies Android when ANDROID_ROOT is set", () => {
		expect(isAndroid({ env: { ANDROID_ROOT: "/system" } })).toBe(true);
	});

	test("identifies Android by process platform", () => {
		expect(isAndroid({ platform: "android" })).toBe(true);
	});

	test("detects ARM64 architecture variants", () => {
		expect(isArm64({ arch: "arm64" })).toBe(true);
		expect(isArm64({ arch: "aarch64" })).toBe(true);
		expect(isArm64({ arch: "x64" })).toBe(false);
	});

	test("produces consistent PlatformSummary", () => {
		const summary = getPlatformSummary({
			env: { PREFIX: "/data/data/com.termux/files/usr" },
			platform: "linux",
			arch: "arm64",
		});
		expect(summary.isAndroid).toBe(true);
		expect(summary.isTermux).toBe(true);
		expect(summary.isArm64).toBe(true);
		expect(summary.termuxPrefix).toBe("/data/data/com.termux/files/usr");
	});
});
