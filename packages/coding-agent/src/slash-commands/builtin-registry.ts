import { clearSubmittedText } from "./helpers/draft";
import type { AutocompleteItem } from "@marsai-org/tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildEffortArgumentCompletions,
	buildEffortInlineHint,
	buildMcpArgumentCompletions,
	buildModelSelectorCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
	buildThemeArgumentCompletions,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { BUILTIN_SKILLS_SLASH_COMMANDS } from "./builtin-skills";
import { BUILTIN_THEME_SLASH_COMMANDS } from "./builtin-theme";
import { commandConsumed, parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_GROUPS: ReadonlyArray<{
	readonly title: string;
	readonly commands: ReadonlyArray<SlashCommandSpec>;
}> = [
	{ title: "Modes & Models", commands: BUILTIN_MODE_SLASH_COMMANDS },
	{ title: "Collaboration & Export", commands: BUILTIN_COLLABORATION_SLASH_COMMANDS },
	{ title: "Session & Diagnostics", commands: BUILTIN_SESSION_SLASH_COMMANDS },
	{ title: "Lifecycle & Workspace", commands: BUILTIN_LIFECYCLE_SLASH_COMMANDS },
	{ title: "Plugins & Marketplace", commands: BUILTIN_MARKETPLACE_SLASH_COMMANDS },
	{ title: "Skills", commands: BUILTIN_SKILLS_SLASH_COMMANDS },
	{ title: "Appearance", commands: BUILTIN_THEME_SLASH_COMMANDS },
	{ title: "Control", commands: BUILTIN_CONTROL_SLASH_COMMANDS },
];

/** Format a command's help block (or the full categorized reference when `query` is empty). */
export function formatBuiltinSlashCommandHelp(query = ""): string {
	const cleaned = query.trim().replace(/^\//, "").toLowerCase();
	if (cleaned) {
		const spec = BUILTIN_SLASH_COMMAND_LOOKUP.get(cleaned);
		if (!spec) {
			const matches = BUILTIN_SLASH_COMMAND_REGISTRY.filter(
				cmd =>
					cmd.name.includes(cleaned) ||
					cmd.description.toLowerCase().includes(cleaned) ||
					(cmd.aliases?.some(alias => alias.includes(cleaned)) ?? false),
			);
			if (matches.length === 0) {
				return `Unknown slash command "/${cleaned}". Run /help to list all built-in commands.`;
			}
			const lines = [`Commands matching "${cleaned}":`];
			for (const cmd of matches) {
				const hint = cmd.inlineHint ? ` ${cmd.inlineHint}` : "";
				lines.push(`  /${cmd.name}${hint} — ${cmd.description}`);
			}
			return lines.join("\n");
		}
		const hint = spec.inlineHint
			? ` ${spec.inlineHint}`
			: spec.subcommands && spec.subcommands.length > 0
				? ` <${spec.subcommands.map(sub => sub.name).join("|")}>`
				: "";
		const lines = [`/${spec.name}${hint}`, `  ${spec.description}`];
		if (spec.aliases && spec.aliases.length > 0) {
			lines.push(`  Aliases: ${spec.aliases.map(alias => `/${alias}`).join(", ")}`);
		}
		if (spec.subcommands && spec.subcommands.length > 0) {
			lines.push("", "  Subcommands:");
			for (const sub of spec.subcommands) {
				const usage = sub.usage ? ` ${sub.usage}` : "";
				lines.push(`    ${sub.name}${usage} — ${sub.description}`);
			}
		}
		return lines.join("\n");
	}

	const sections: string[] = ["Mars Slash Commands (use /help <command> for details, /hotkeys for shortcuts):"];
	for (const group of BUILTIN_SLASH_COMMAND_GROUPS) {
		sections.push("", `${group.title}:`);
		for (const cmd of group.commands) {
			const aliases = cmd.aliases && cmd.aliases.length > 0 ? ` (${cmd.aliases.map(a => `/${a}`).join(", ")})` : "";
			const hint = cmd.inlineHint ? ` ${cmd.inlineHint}` : "";
			sections.push(`  /${cmd.name}${hint}${aliases} — ${cmd.description}`);
		}
	}
	return sections.join("\n");
}

const HELP_SLASH_COMMAND: SlashCommandSpec = {
	name: "help",
	aliases: ["commands"],
	icon: "question",
	description: "Show built-in slash commands or detailed usage for a command",
	acpDescription: "List built-in slash commands or inspect one command",
	inlineHint: "[command]",
	allowArgs: true,
	handle: async (command, runtime) => {
		await runtime.output(formatBuiltinSlashCommandHelp(command.args));
		return commandConsumed();
	},
	handleTui: (command, runtime) => {
		runtime.ctx.showStatus(formatBuiltinSlashCommandHelp(command.args));
		clearSubmittedText(runtime);
	},
};

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_SKILLS_SLASH_COMMANDS,
	...BUILTIN_THEME_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
	HELP_SLASH_COMMAND,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		// Getter: some descriptions name keys, formatted at read time (theme/preset may change).
		get description() {
			return command.description;
		},
		icon: command.icon,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		const subcommands = cmd.subcommands;
		// `/mcp` and `/effort` narrow their declarative lists to live session
		// state so the dropdown never offers a value the handler would reject.
		if (runtime && cmd.name === "mcp") {
			materialized.getArgumentCompletions = buildMcpArgumentCompletions(subcommands, runtime);
			materialized.getInlineHint = buildSubcommandInlineHint(subcommands);
		} else if (runtime && cmd.name === "effort") {
			materialized.getArgumentCompletions = buildEffortArgumentCompletions(runtime);
			materialized.getInlineHint = buildEffortInlineHint(runtime);
		} else if (cmd.name === "theme") {
			materialized.getArgumentCompletions = buildThemeArgumentCompletions(subcommands);
			materialized.getInlineHint = buildSubcommandInlineHint(subcommands);
		} else {
			materialized.getArgumentCompletions = buildArgumentCompletions(subcommands);
			materialized.getInlineHint = buildSubcommandInlineHint(subcommands);
		}
	} else if (cmd.name === "move" || cmd.name === "add-dir") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "switch" && runtime) {
		materialized.getArgumentCompletions = buildModelSelectorCompletions(runtime);
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "force" && runtime) {
		materialized.getArgumentCompletions = (argumentPrefix: string) => {
			if (argumentPrefix.includes(" ")) return null;
			const lower = argumentPrefix.toLowerCase();
			const tools = runtime.ctx.session.getActiveToolNames();
			const matches = tools
				.filter(name => name.toLowerCase().startsWith(lower))
				.map(name => ({ value: `${name} `, label: name }));
			return matches.length > 0 ? matches : null;
		};
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "help") {
		materialized.getArgumentCompletions = (argumentPrefix: string) => {
			if (argumentPrefix.includes(" ")) return null;
			const lower = argumentPrefix.trim().replace(/^\//, "").toLowerCase();
			const matches = BUILTIN_SLASH_COMMAND_REGISTRY.filter(c => c.name.startsWith(lower)).map(c => ({
				value: `${c.name} `,
				label: c.name,
				description: c.description,
			}));
			return matches.length > 0 ? matches : null;
		};
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		clearSubmittedText(runtime);
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		clearSubmittedText(runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
