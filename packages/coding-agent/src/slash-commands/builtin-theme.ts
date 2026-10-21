import { getAvailableThemes, isLightTheme, setTheme } from "@marsai-org/tui/theme";
import { cfgThemeDark, cfgThemeLight } from "../modes/settings";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

/**
 * Preview or switch the active colour theme.
 *
 * `/theme` lists available themes.
 * `/theme preview <name>` loads the theme, shows a compact swatch block,
 * and restores the previous theme after a short delay so an experiment never
 * changes what the user sees next session.
 * `/theme set <name>` permanently switches to the theme.
 */

const PREVIEW_MS = 4_000;

function swatchLines(theme: Awaited<ReturnType<typeof import("@marsai-org/tui/theme").getThemeByName>>): string[] {
	if (!theme) return [];
	const rows: Array<[string, Parameters<typeof theme.fg>[0], string]> = [
		["accent ", "accent", "Mars orange"],
		["text   ", "text", "The quick brown fox"],
		["muted  ", "muted", "secondary detail"],
		["success", "success", "ok"],
		["warning", "warning", "careful"],
		["error  ", "error", "failed"],
		["heading", "mdHeading", "Markdown heading"],
		["code   ", "mdCode", "const mars = true"],
		["border ", "borderAccent", "────────────"],
	];
	return rows.map(([label, color, sample]) => ` ${theme.fg("muted", label)} ${theme.fg(color, sample)}`);
}

const subcommands: SubcommandDef[] = [
	{ name: "preview", description: "Temporarily apply a theme to evaluate it in place", usage: "<name>" },
	{ name: "set", description: "Switch to a theme permanently", usage: "<name>" },
	{ name: "list", description: "List installed themes" },
];

export const BUILTIN_THEME_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "theme",
		icon: "settings",
		description: "Preview or switch the colour theme",
		subcommands,
		inlineHint: "[preview|set|list] [name]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const [sub = "list", name] = command.args.trim().split(/\s+/, 2);
			try {
				const available = await getAvailableThemes();
				if (sub === "list" || (sub !== "preview" && sub !== "set")) {
					await runtime.output(`Themes: ${available.join(", ")}`);
					await runtime.output("Preview one with /theme preview <name>, keep it with /theme set <name>.");
					return commandConsumed();
				}
				if (!name) return usage(`Usage: /theme ${sub} <name>`, runtime);
				if (!available.includes(name)) {
					return usage(`Unknown theme "${name}". Available: ${available.join(", ")}`, runtime);
				}

				const { getThemeByName } = await import("@marsai-org/tui/theme");
				const candidate = await getThemeByName(name);
				const applied = await setTheme(name, false);
				if (!applied.success) return usage(applied.error ?? `Could not apply ${name}`, runtime);

				const lines = [` Theme: ${name}`, ...swatchLines(candidate)];

				if (sub === "set") {
					// `setTheme` only swaps the live instance. Persisting the name is
					// what makes the choice survive the session; without it the next
					// launch silently returned to the previous theme even though this
					// command said "Theme set to <name>".
					const slot = isLightTheme(name) ? cfgThemeLight : cfgThemeDark;
					slot.set(runtime.settings, name);
					await runtime.settings.flush();
					await runtime.output(lines.join("\n"));
					await runtime.output(`Theme set to ${name}.`);
					return commandConsumed();
				}

				lines.push(` (reverting in ${PREVIEW_MS / 1000}s — keep it with /theme set ${name})`);
				await runtime.output(lines.join("\n"));

				setTimeout(() => {
					void (async () => {
						await setTheme("dark", false);
					})();
				}, PREVIEW_MS).unref?.();
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			return commandConsumed();
		},
	},
];
