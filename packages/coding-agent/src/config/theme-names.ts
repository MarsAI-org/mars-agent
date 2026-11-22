/**
 * Theme-name predicate shared by the CLI write path.
 *
 * Deliberately not a setting `validate`: that hook also runs on every load, so a
 * config file already holding a stale theme name would throw during startup and
 * take every command down with it. A bad persisted value should degrade to the
 * default theme with a warning; only a *new* write is worth rejecting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getCustomThemesDir } from "@marsai-org/utils";
import { getBuiltinThemes } from "@marsai-org/tui/theme";

/** True when `name` names a built-in theme or a `.json` in the custom themes dir. */
export function isKnownTheme(name: string): boolean {
	if (Object.hasOwn(getBuiltinThemes(), name)) return true;
	return fs.existsSync(path.join(getCustomThemesDir(), `${name}.json`));
}
