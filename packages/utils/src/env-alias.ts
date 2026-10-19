/**
 * Compatibility shim for the environment-variable helpers.
 *
 * The implementation moved to `env-compat.ts` when the `OMP_*` and `PI_*`
 * migrations were unified. This module keeps the original import path working
 * for `dirs.ts` and for hosts that imported `@marsai-org/utils/env-alias`
 * directly.
 */

export {
	__resetLegacyEnvWarningsForTests as __resetEnvAliasNoticesForTests,
	__takeEnvAliasNoticesForTests,
	envAliasNotice,
	envAliasNoticesEnabled,
	flushEnvAliasNotices,
	isBunTestRuntime,
	noteInternalEnvWrite,
	reportLegacyEnvAliases,
	resolveEnvAlias,
	USER_FACING_ENV_ALIASES as LEGACY_ENV_ALIASES,
} from "./env-compat";
