/**
 * Platform and environment detection for Mars.
 *
 * Single source of truth for detecting Android and Termux execution
 * environments, normalized host architectures, and mobile runtime modes.
 * Functions accept an optional environment map so callers and tests can
 * inject fake environments without mutating process.env.
 */

export interface PlatformEnvironment {
	readonly env?: Record<string, string | undefined>;
	readonly platform?: string;
	readonly arch?: string;
}

/**
 * Whether the process is running inside the Termux userland on Android.
 *
 * Termux sets `PREFIX` (typically `/data/data/com.termux/files/usr`) and
 * `TERMUX_VERSION`. Checking both covers direct Termux shells as well as
 * sub-processes spawned under Termux without all env inherited.
 */
export function isTermux(context: PlatformEnvironment = {}): boolean {
	const env = context.env ?? process.env;
	const prefix = env.PREFIX ?? "";
	if (prefix.includes("com.termux")) return true;
	if (env.TERMUX_VERSION !== undefined && env.TERMUX_VERSION.length > 0) return true;
	if (env.TERMUX_APP_PID !== undefined && env.TERMUX_APP_PID.length > 0) return true;
	return false;
}

/**
 * Whether the process is running on Android (native Bionic libc, Termux,
 * or an Android-hosted sub-environment).
 */
export function isAndroid(context: PlatformEnvironment = {}): boolean {
	const platform = context.platform ?? process.platform;
	if (platform === "android") return true;
	if (isTermux(context)) return true;
	const env = context.env ?? process.env;
	if (env.ANDROID_ROOT !== undefined || env.ANDROID_DATA !== undefined) return true;
	return false;
}

/**
 * Whether the current platform is an ARM64 host (aarch64).
 */
export function isArm64(context: PlatformEnvironment = {}): boolean {
	const arch = context.arch ?? process.arch;
	return arch === "arm64" || arch === "aarch64";
}

export interface PlatformSummary {
	readonly isAndroid: boolean;
	readonly isTermux: boolean;
	readonly isArm64: boolean;
	readonly platform: string;
	readonly arch: string;
	readonly termuxPrefix: string | undefined;
}

/**
 * Structured platform facts for telemetry, diagnostic reporting, and the
 * offline self-check command.
 */
export function getPlatformSummary(context: PlatformEnvironment = {}): PlatformSummary {
	const env = context.env ?? process.env;
	const platform = context.platform ?? process.platform;
	const arch = context.arch ?? process.arch;
	const termux = isTermux(context);
	return {
		isAndroid: isAndroid(context),
		isTermux: termux,
		isArm64: isArm64(context),
		platform,
		arch,
		termuxPrefix: termux ? (env.PREFIX ?? undefined) : undefined,
	};
}
