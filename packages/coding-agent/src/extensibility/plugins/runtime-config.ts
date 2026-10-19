import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, logger } from "@marsai-org/utils";
import type { PluginRuntimeConfig } from "./types";

/** Canonical plugin lock file name inside a plugin root. */
export const PLUGINS_LOCKFILE_NAME = `${APP_NAME}-plugins.lock.json`;

/** Pre-rebrand plugin lock file name. Read once, then migrated to the canonical name. */
export const LEGACY_PLUGINS_LOCKFILE_NAME = "omp-plugins.lock.json";

/** Canonical lock file path for a plugin root (user, project, or marketplace scope). */
export function pluginsLockfilePath(root: string): string {
	return path.join(root, PLUGINS_LOCKFILE_NAME);
}

/** Legacy lock file path for a plugin root. */
export function legacyPluginsLockfilePath(root: string): string {
	return path.join(root, LEGACY_PLUGINS_LOCKFILE_NAME);
}

/**
 * Rename a pre-rebrand `omp-plugins.lock.json` to the canonical
 * `mars-plugins.lock.json` in the same root.
 *
 * The rename happens once, only when the canonical file is absent, so a
 * reader and writer never observe two competing lock files. When both files
 * exist the canonical one wins and the stale legacy file is reported instead
 * of being silently ignored or deleted.
 *
 * @returns the lock path to read: the canonical one after migration, or the
 *   legacy one when the root is not writable.
 */
export async function migrateLegacyPluginsLockfile(root: string): Promise<string> {
	const lockPath = pluginsLockfilePath(root);
	const legacyPath = legacyPluginsLockfilePath(root);
	const [canonicalExists, legacyExists] = await Promise.all([exists(lockPath), exists(legacyPath)]);

	if (canonicalExists) {
		if (legacyExists) {
			logger.warn("plugins: ignoring stale legacy lock file; the canonical lock file wins", {
				path: lockPath,
				legacyPath,
			});
		}
		return lockPath;
	}
	if (!legacyExists) return lockPath;

	try {
		await fs.rename(legacyPath, lockPath);
	} catch (error) {
		// A concurrent first run may have migrated first; then the canonical
		// file exists and the state is already consistent.
		if (await exists(lockPath)) return lockPath;
		logger.warn("plugins: failed to migrate legacy lock file; reading it in place", {
			path: legacyPath,
			target: lockPath,
			error: String(error),
		});
		// A read-only root cannot be renamed: read the legacy file so existing
		// plugin state still loads, and leave migration to a writable run.
		if (await exists(legacyPath)) return legacyPath;
	}
	return lockPath;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch {
		return false;
	}
}

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}
