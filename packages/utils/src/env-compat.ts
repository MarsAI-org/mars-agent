/**
 * Legacy environment-variable compatibility for the OMP_ -> MARS_ rebrand.
 *
 * `OMP_` was the pre-rebrand variable prefix (oh-my-pi). Every variable this
 * module knows about is now documented, printed, and set as `MARS_*`; the old
 * spelling remains readable so existing shells, service units, and dotenv
 * files keep working. New code MUST read the canonical name only through
 * {@link readCompatEnv} / {@link flagCompatEnv} / {@link pickCompatEnv} so the
 * fallback and its one-time warning stay in one place.
 *
 * Rules:
 * - `MARS_<NAME>` wins whenever it is defined, including when it is explicitly
 *   empty. This mirrors `resolveProfileEnv` in `dirs.ts`: an explicitly-empty
 *   canonical value is a deliberate choice and must NOT silently inherit the
 *   legacy value.
 * - `OMP_<NAME>` is consulted only when the canonical name is absent.
 * - A deprecation warning is emitted at most once per process per variable.
 *
 * This module must not import `logger` or `dirs`: it is loaded from early
 * module initialization (log level, app URL, directory overrides), and a cycle
 * through the logger would be observable. Warnings go to the process logger
 * only when a sink has already been configured; otherwise they are queued and
 * flushed by {@link takeLegacyEnvWarnings} for the CLI host to print.
 */

/** Canonical-to-legacy variable pairs this build still accepts. */
export const LEGACY_ENV_ALIASES: Readonly<Record<string, string>> = {
	MARS_APP_NAME: "OMP_APP_NAME",
	MARS_APP_URL: "OMP_APP_URL",
	MARS_AUTORESEARCH_DB_DIR: "OMP_AUTORESEARCH_DB_DIR",
	MARS_AUTH_BROKER_ACCOUNT_POOL_FILE: "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	MARS_AUTH_BROKER_SNAPSHOT_CACHE: "OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	MARS_AUTH_BROKER_SNAPSHOT_TTL_MS: "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
	MARS_AUTH_BROKER_TOKEN: "OMP_AUTH_BROKER_TOKEN",
	MARS_AUTH_BROKER_URL: "OMP_AUTH_BROKER_URL",
	MARS_COMMIT_CACHE_DB: "OMP_COMMIT_CACHE_DB",
	MARS_DAEMON_IDLE_GRACE_MS: "OMP_DAEMON_IDLE_GRACE_MS",
	MARS_GITHUB_CACHE_DB: "OMP_GITHUB_CACHE_DB",
	MARS_HARMONY_DEBUG: "OMP_HARMONY_DEBUG",
	MARS_JUDGMENT_CACHE_DB: "OMP_JUDGMENT_CACHE_DB",
	MARS_LOG_LEVEL: "OMP_LOG_LEVEL",
	MARS_MCP_REQUIRE_READY: "OMP_MCP_REQUIRE_READY",
	MARS_MCP_STARTUP_TIMEOUT_MS: "OMP_MCP_STARTUP_TIMEOUT_MS",
	MARS_MCP_TIMEOUT_MS: "OMP_MCP_TIMEOUT_MS",
	MARS_NO_WEBP: "OMP_NO_WEBP",
	MARS_PROFILE: "OMP_PROFILE",
	MARS_SKIP_SETUP: "OMP_SKIP_SETUP",
	MARS_TUI_DEBUG: "OMP_TUI_DEBUG",
	MARS_WORKTREE_DIR: "OMP_WORKTREE_DIR",
};

/** Warnings already emitted in this process, keyed by the legacy variable name. */
const emitted = new Set<string>();

/** Warnings that arrived before any output sink was ready. */
const pending: string[] = [];

/**
 * Record a legacy fallback once. Returns the warning text on the first call for
 * this variable and `undefined` afterwards, so a caller that has its own sink
 * can print it directly instead of using the queue.
 */
export function noteLegacyEnvUse(canonical: string, legacy: string): string | undefined {
	if (emitted.has(legacy)) return undefined;
	emitted.add(legacy);
	const message = `${legacy} is deprecated; use ${canonical} instead.`;
	pending.push(message);
	return message;
}

/**
 * Drain warnings recorded before a host was ready to print them. The CLI prints
 * these through its startup-notice sink; other hosts may ignore the return
 * value. Never throws.
 */
export function takeLegacyEnvWarnings(): string[] {
	return pending.splice(0);
}

/** Test-only: forget emitted and queued warnings so each case starts clean. */
export function __resetLegacyEnvWarningsForTests(): void {
	emitted.clear();
	pending.length = 0;
}

/**
 * Read `MARS_<NAME>`, falling back to `OMP_<NAME>`.
 *
 * Returns the raw string (untrimmed) exactly as the environment stores it, so
 * callers keep their own trimming and emptiness semantics. `undefined` means
 * neither name is defined.
 */
export function readCompatEnv(
	canonical: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const value = env[canonical];
	if (value !== undefined) return value;
	const legacy = LEGACY_ENV_ALIASES[canonical];
	if (legacy === undefined) return undefined;
	const legacyValue = env[legacy];
	if (legacyValue === undefined) return undefined;
	noteLegacyEnvUse(canonical, legacy);
	return legacyValue;
}

/**
 * `$pickenv` with legacy support: returns the first defined, non-empty
 * (trimmed) value among the supplied canonical names and their aliases.
 */
export function pickCompatEnv(
	names: readonly string[],
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	for (const name of names) {
		const value = readCompatEnv(name, env)?.trim();
		if (value) return value;
	}
	return undefined;
}

/** Truthy values accepted by the shared `$flag` parser. */
const TRUTHY: Readonly<Record<string, true>> = {
	"1": true,
	y: true,
	Y: true,
	true: true,
	TRUE: true,
	yes: true,
	YES: true,
	on: true,
	ON: true,
};

/**
 * Boolean compat read with `$flag` semantics: an empty value is ignored (so the
 * setting applies), and any non-empty value outside the truthy set is false.
 */
export function flagCompatEnv(
	name: string,
	def = false,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = readCompatEnv(name, env);
	if (!raw) return def;
	return TRUTHY[raw] === true;
}
