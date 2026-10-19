/**
 * Legacy environment-variable compatibility for the rebrand.
 *
 * Two rename generations are still readable:
 * - `OMP_*` was the pre-rebrand prefix (oh-my-pi).
 * - `PI_*` was the original prefix (Pi), kept for older shells and service units.
 *
 * Every variable this module knows about is documented, printed, and set as
 * `MARS_*`; the old spellings remain readable so existing shells, service
 * units, and dotenv files keep working. New code MUST read the canonical name
 * only through {@link readCompatEnv} / {@link flagCompatEnv} /
 * {@link pickCompatEnv} so the fallback and its one-time warning stay in one
 * place.
 *
 * Rules:
 * - `MARS_<NAME>` wins whenever it is defined, including when it is explicitly
 *   empty. This mirrors `resolveProfileEnv` in `dirs.ts`: an explicitly-empty
 *   canonical value is a deliberate choice and must NOT silently inherit the
 *   legacy value.
 * - A legacy name is consulted only when the canonical name is absent, in
 *   declaration order (`OMP_*` before `PI_*`).
 * - A deprecation warning is emitted at most once per process per variable.
 *
 * This module must not import `logger` or `dirs`: it is loaded from early
 * module initialization (log level, app URL, directory overrides), and a cycle
 * through the logger would be observable. Warnings go to the process logger
 * only when a sink has already been configured; otherwise they are queued and
 * flushed by {@link takeLegacyEnvWarnings} for the CLI host to print.
 */

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}

/**
 * Canonical-to-legacy variable pairs this build still accepts.
 *
 * Ordered most-recent rename first: `OMP_*` supersedes `PI_*`, so a shell that
 * still exports both is read through the newer spelling.
 */
export const LEGACY_ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
	MARS_APP_NAME: ["OMP_APP_NAME", "PI_APP_NAME"],
	MARS_APP_URL: ["OMP_APP_URL", "PI_APP_URL"],
	MARS_AUTORESEARCH_DB_DIR: ["OMP_AUTORESEARCH_DB_DIR", "PI_AUTORESEARCH_DB_DIR"],
	MARS_AUTH_BROKER_ACCOUNT_POOL_FILE: ["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "PI_AUTH_BROKER_ACCOUNT_POOL_FILE"],
	MARS_AUTH_BROKER_SNAPSHOT_CACHE: ["OMP_AUTH_BROKER_SNAPSHOT_CACHE", "PI_AUTH_BROKER_SNAPSHOT_CACHE"],
	MARS_AUTH_BROKER_SNAPSHOT_TTL_MS: ["OMP_AUTH_BROKER_SNAPSHOT_TTL_MS", "PI_AUTH_BROKER_SNAPSHOT_TTL_MS"],
	MARS_AUTH_BROKER_TOKEN: ["OMP_AUTH_BROKER_TOKEN", "PI_AUTH_BROKER_TOKEN"],
	MARS_AUTH_BROKER_URL: ["OMP_AUTH_BROKER_URL", "PI_AUTH_BROKER_URL"],
	MARS_CODING_AGENT_DIR: ["OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"],
	MARS_COMMIT_CACHE_DB: ["OMP_COMMIT_CACHE_DB", "PI_COMMIT_CACHE_DB"],
	MARS_CONFIG_DIR: ["OMP_CONFIG_DIR", "PI_CONFIG_DIR"],
	MARS_DAEMON_IDLE_GRACE_MS: ["OMP_DAEMON_IDLE_GRACE_MS", "PI_DAEMON_IDLE_GRACE_MS"],
	MARS_GITHUB_CACHE_DB: ["OMP_GITHUB_CACHE_DB", "PI_GITHUB_CACHE_DB"],
	MARS_HARMONY_DEBUG: ["OMP_HARMONY_DEBUG", "PI_HARMONY_DEBUG"],
	MARS_JUDGMENT_CACHE_DB: ["OMP_JUDGMENT_CACHE_DB", "PI_JUDGMENT_CACHE_DB"],
	MARS_LOG_LEVEL: ["OMP_LOG_LEVEL", "PI_LOG_LEVEL"],
	MARS_MCP_REQUIRE_READY: ["OMP_MCP_REQUIRE_READY", "PI_MCP_REQUIRE_READY"],
	MARS_MCP_STARTUP_TIMEOUT_MS: ["OMP_MCP_STARTUP_TIMEOUT_MS", "PI_MCP_STARTUP_TIMEOUT_MS"],
	MARS_MCP_TIMEOUT_MS: ["OMP_MCP_TIMEOUT_MS", "PI_MCP_TIMEOUT_MS"],
	MARS_NO_PTY: ["OMP_NO_PTY", "PI_NO_PTY"],
	MARS_NO_WEBP: ["OMP_NO_WEBP", "PI_NO_WEBP"],
	MARS_PACKAGE_DIR: ["OMP_PACKAGE_DIR", "PI_PACKAGE_DIR"],
	MARS_PLAN_MODEL: ["OMP_PLAN_MODEL", "PI_PLAN_MODEL"],
	MARS_PROFILE: ["OMP_PROFILE", "PI_PROFILE"],
	MARS_SKIP_SETUP: ["OMP_SKIP_SETUP", "PI_SKIP_SETUP"],
	MARS_SLOW_MODEL: ["OMP_SLOW_MODEL", "PI_SLOW_MODEL"],
	MARS_SMOL_MODEL: ["OMP_SMOL_MODEL", "PI_SMOL_MODEL"],
	MARS_TUI_DEBUG: ["OMP_TUI_DEBUG", "PI_TUI_DEBUG"],
	MARS_WORKTREE_DIR: ["OMP_WORKTREE_DIR", "PI_WORKTREE_DIR"],
};

/** Warnings already emitted in this process, keyed by the legacy variable name. */
const emitted = new Set<string>();

/** Warnings that arrived before any output sink was ready. */
const pending: string[] = [];

/**
 * Legacy values written by Mars itself (profile propagation to children,
 * worker hand-off). Reading one back must not tell the user to migrate a
 * variable they never set.
 */
const internallyWritten = new Map<string, string>();

/**
 * Record that `name` currently holds a value Mars wrote itself. Later reads of
 * that exact value stay quiet; a user-supplied value still warns.
 */
export function noteInternalEnvWrite(name: string, value: string | undefined): void {
	if (value === undefined) internallyWritten.delete(name);
	else internallyWritten.set(name, value);
}

/** Exact deprecation line emitted for a legacy variable. */
export function envAliasNotice(legacy: string, canonical: string): string {
	return `mars: ${legacy} is deprecated and will be removed in a future release; use ${canonical} instead.\n`;
}

/**
 * Record a legacy fallback once. Returns the warning text on the first call for
 * this variable and `undefined` afterwards, so a caller that has its own sink
 * can print it directly instead of using the queue.
 */
export function noteLegacyEnvUse(canonical: string, legacy: string): string | undefined {
	if (emitted.has(legacy)) return undefined;
	emitted.add(legacy);
	const message = envAliasNotice(legacy, canonical);
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

export interface EnvAliasOptions {
	/** Environment source; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Skip the deprecation notice for this lookup. Used where the legacy value
	 * was written by Mars itself (internal propagation to children) rather than
	 * by the user.
	 */
	quiet?: boolean;
}

/**
 * Resolve a renamed environment variable across both legacy generations.
 *
 * The canonical name wins whenever it holds a non-empty value. Otherwise the
 * first legacy name that holds a value is returned and one deprecation notice
 * is queued per legacy name per process. Empty values count as unset, matching
 * how these overrides were historically treated.
 */
export function resolveEnvAlias(
	canonical: string,
	legacy: string | readonly string[],
	options: EnvAliasOptions = {},
): string | undefined {
	const env = options.env ?? process.env;
	const canonicalValue = env[canonical];
	if (canonicalValue !== undefined && canonicalValue.trim() !== "") return canonicalValue;
	const names = typeof legacy === "string" ? [legacy] : legacy;
	for (const name of names) {
		const value = env[name];
		if (value === undefined || value.trim() === "") continue;
		const selfWritten = internallyWritten.get(name) === value;
		if (!options.quiet && !selfWritten) noteLegacyEnvUse(canonical, name);
		return value;
	}
	return undefined;
}

/**
 * Read `MARS_<NAME>`, falling back to its legacy names.
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
	for (const name of legacy) {
		const legacyValue = env[name];
		if (legacyValue === undefined) continue;
		noteLegacyEnvUse(canonical, name);
		return legacyValue;
	}
	return undefined;
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

/**
 * User-facing variables migrated from legacy prefixes. Hosts call
 * {@link reportLegacyEnvAliases} once at startup so a legacy value is reported
 * even when the feature that consumes it only runs much later.
 */
export const USER_FACING_ENV_ALIASES: readonly (readonly [canonical: string, legacy: string])[] =
	Object.entries(LEGACY_ENV_ALIASES).flatMap(([canonical, legacyNames]) =>
		legacyNames.map(name => [canonical, name] as const),
	);

/** Queue a notice for every legacy name the user actually set. */
export function reportLegacyEnvAliases(env: Record<string, string | undefined> = process.env): void {
	for (const [canonical, legacy] of USER_FACING_ENV_ALIASES) resolveEnvAlias(canonical, legacy, { env });
}

/**
 * True when queued notices should reach the terminal. Deprecation output is
 * quiet by default: it is skipped in tests and when stderr is not a terminal
 * (piped output, RPC hosts, CI logs). `MARS_ENV_DEPRECATION_WARNINGS=1` forces
 * it on; `MARS_NO_DEPRECATION_WARNINGS=1` silences it everywhere.
 */
export function envAliasNoticesEnabled(): boolean {
	if (isBunTestRuntime()) return false;
	if (Bun.env.MARS_NO_DEPRECATION_WARNINGS === "1") return false;
	if (Bun.env.MARS_ENV_DEPRECATION_WARNINGS === "1") return true;
	return process.stderr.isTTY === true;
}

/**
 * Drain queued deprecation lines through the caller's sink. Returns the number
 * of notices written. Hosts call this once, before the TUI starts, so the
 * queue can never interleave with rendered frames.
 */
export function flushEnvAliasNotices(write: (text: string) => void): number {
	if (pending.length === 0) return 0;
	const notices = pending.splice(0);
	if (!envAliasNoticesEnabled()) return 0;
	for (const notice of notices) write(notice);
	return notices.length;
}

/** Test-only: forget emitted and queued warnings so each case starts clean. */
export function __resetLegacyEnvWarningsForTests(): void {
	emitted.clear();
	pending.length = 0;
	internallyWritten.clear();
}

/** Test-only: drain queued notices without printing. */
export function __takeEnvAliasNoticesForTests(): string[] {
	return pending.splice(0);
}
