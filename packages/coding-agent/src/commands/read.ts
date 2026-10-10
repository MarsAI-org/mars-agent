/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */

import { Args, Command } from "@marsai-org/utils/cli";
import { readHelp as commandHelp } from "../cli/command-help";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "@marsai-org/tui/theme";

export default class Read extends Command {
	static description = commandHelp.description;
	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"mars read src/foo.ts",
		"mars read src/foo.ts:50-100",
		"mars read src/foo.ts:raw",
		"mars read https://example.com",
		"`mars read omp://`",
		"mars read issue://123",
		"mars read path/to/archive.zip:dir/file.ts",
		"mars read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
