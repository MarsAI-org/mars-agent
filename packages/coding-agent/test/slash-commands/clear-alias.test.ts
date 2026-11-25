import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@marsai-org/coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
	formatBuiltinSlashCommandHelp,
	lookupBuiltinSlashCommand,
} from "@marsai-org/coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@marsai-org/tui/autocomplete";

describe("/clear slash command", () => {
	it("resolves /clear to the context reset command and removed /clear alias from /new", async () => {
		const provider = new CombinedAutocompleteProvider(
			[...BUILTIN_SLASH_COMMANDS, { name: "autoresearch", description: "Clear stale research results" }],
			process.cwd(),
		);

		const suggestions = await provider.getSuggestions(["/clear"], 0, 6);

		expect(suggestions?.items[0]).toMatchObject({
			value: "clear",
			description: "Clear the conversation context in place, keeping the session",
		});
		expect(lookupBuiltinSlashCommand("clear")?.name).toBe("clear");
		expect(lookupBuiltinSlashCommand("new")?.aliases).toBeUndefined();
		expect(lookupBuiltinSlashCommand("reset")).toBeUndefined();
	});
});

describe("/help slash command & argument completions", () => {
	it("renders categorized overview on bare /help and detailed subcommand reference on /help <command>", async () => {
		const showStatus = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText },
				showStatus,
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/help", runtime)).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Mars Slash Commands"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Modes & Models:"));

		showStatus.mockClear();
		expect(await executeBuiltinSlashCommand("/help effort", runtime)).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/effort [level]"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Subcommands:"));

		expect(formatBuiltinSlashCommandHelp("unknown-xyz")).toContain('Unknown slash command "/unknown-xyz"');
	});

	it("provides live active-tool completions for /force and command-name completions for /help", async () => {
		const runtime = {
			ctx: {
				session: {
					getActiveToolNames: () => ["bash", "read", "write"],
				},
			} as unknown as InteractiveModeContext,
		};
		const commands = buildTuiBuiltinSlashCommands(runtime);
		const force = commands.find(cmd => cmd.name === "force");
		const help = commands.find(cmd => cmd.name === "help");

		const forceMatches = await force?.getArgumentCompletions?.("wr");
		expect(forceMatches?.map(item => item.label)).toEqual(["write"]);

		const helpMatches = await help?.getArgumentCompletions?.("eff");
		expect(helpMatches?.map(item => item.label)).toContain("effort");
	});
});
