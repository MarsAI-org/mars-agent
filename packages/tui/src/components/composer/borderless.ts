/**
 * Chrome-free composer: a bare `❯ ` prompt with no rules or borders. Also the
 * effective style whenever a host calls `setBorderVisible(false)` (hook
 * editors, agents hub). The status bar renders as a plain standalone bottom
 * bar with both segment groups.
 */
import { theme } from "../../theme/theme";
import type { ComposerRowContext, ComposerStyle } from "./types";

function isAsciiPreset(): boolean {
	return typeof theme !== "undefined" && theme.getSymbolPreset() === "ascii";
}

export const borderlessComposerStyle: ComposerStyle = {
	id: "borderless",
	sideBorders: false,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: false,
	get defaultPromptGutter(): string {
		return isAsciiPreset() ? "> " : "❯ ";
	},

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(): number {
		return 0;
	},

	renderTop(): undefined {
		return undefined;
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
