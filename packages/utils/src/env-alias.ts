/**
 * Environment-variable rename support: canonical `MARS_*` names with the
 * legacy `PI_*` names kept as a compatibility fallback.
 *
 * The CLI documents `MARS_*` as the primary prefix. Existing installations may
 * still export `PI_*`; those keep working. When a legacy value is actually
 * consulted, one deprecation line is queued for that variable. The CLI drains
 * the queue once, early, on stderr — never from inside the TUI, a worker, or a
 * library import.
 *
 * This module deliberately has no imports from `dirs.ts` or `env.ts`: both
 * import it, and `dirs.ts` loads before the dotenv layer runs.
 */

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}

/** Legacy names already reported in this process. */
const reportedNotices = new Set<string>();

/** Pending deprecation lines, in first-use order. */
const pendingNotices: string[] = [];

/**
 * Legacy values written by Mars itself (profile propagation to children,
 * `setAgentDir`, worker hand-off). Reading one back must not tell the user to
 * migrate a variable they never set.
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

/** Exact deprecation line emitted for a legacy variable. */
export function envAliasNotice(legacy: string, canonical: string): string {
	return `mars: ${legacy} is deprecated and will be removed in a future release; use ${canonical} instead.\n`;
}

function recordNotice(legacy: string, canonical: string, quiet: boolean): void {
	if (quiet || reportedNotices.has(legacy)) return;
	reportedNotices.add(legacy);
	pendingNotices.push(envAliasNotice(legacy, canonical));
}

/**
 * Resolve a renamed environment variable.
 *
 * The canonical name wins whenever it holds a non-empty value. Otherwise the
 * legacy name is returned and one deprecation notice is queued per legacy name
 * per process. Empty values count as unset, matching how these overrides were
 * historically treated.
 */
export function resolveEnvAlias(
	canonical: string,
	legacy: string,
	options: EnvAliasOptions = {},
): string | undefined {
	const env = options.env ?? process.env;
	const canonicalValue = env[canonical];
	if (canonicalValue !== undefined && canonicalValue.trim() !== "") return canonicalValue;
	const legacyValue = env[legacy];
	if (legacyValue === undefined || legacyValue.trim() === "") return undefined;
	const selfWritten = internallyWritten.get(legacy) === legacyValue;
	recordNotice(legacy, canonical, options.quiet === true || selfWritten);
	return legacyValue;
}

/**
 * User-facing variables migrated from `PI_*` to `MARS_*`. Hosts call
 * {@link reportLegacyEnvAliases} once at startup so a legacy value is reported
 * even when the feature that consumes it only runs much later.
 */
export const LEGACY_ENV_ALIASES: readonly (readonly [canonical: string, legacy: string])[] = [
	["MARS_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"],
	["MARS_CONFIG_DIR", "PI_CONFIG_DIR"],
	["MARS_PACKAGE_DIR", "PI_PACKAGE_DIR"],
	["MARS_SMOL_MODEL", "PI_SMOL_MODEL"],
	["MARS_SLOW_MODEL", "PI_SLOW_MODEL"],
	["MARS_PLAN_MODEL", "PI_PLAN_MODEL"],
	["MARS_NO_PTY", "PI_NO_PTY"],
];

/** Queue a notice for every legacy name the user actually set. */
export function reportLegacyEnvAliases(env: Record<string, string | undefined> = process.env): void {
	for (const [canonical, legacy] of LEGACY_ENV_ALIASES) resolveEnvAlias(canonical, legacy, { env });
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
	if (pendingNotices.length === 0) return 0;
	const notices = pendingNotices.splice(0);
	if (!envAliasNoticesEnabled()) return 0;
	for (const notice of notices) write(notice);
	return notices.length;
}

/** Drain queued notices without printing. Test-only. */
export function __takeEnvAliasNoticesForTests(): string[] {
	return pendingNotices.splice(0);
}

/** Clear the once-per-process notice state. Test-only. */
export function __resetEnvAliasNoticesForTests(): void {
	reportedNotices.clear();
	pendingNotices.length = 0;
	internallyWritten.clear();
}
