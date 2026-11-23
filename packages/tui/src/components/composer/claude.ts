/**
 * Claude Code-like composer: full-width horizontal rules above and below a
 * borderless `❯ ` prompt. The right status group rides the top rule as a
 * bg chip near the right edge (`─────── hi ─`); the left group renders as a
 * plain standalone bottom bar that yields its row to the autocomplete menu.
 */

import { theme } from "../../theme/theme";
import { padding } from "../../utils";
import { renderTopRule } from "./rule";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

function isAsciiPreset(): boolean {
	return typeof theme !== "undefined" && theme.getSymbolPreset() === "ascii";
}

export const claudeComposerStyle: ComposerStyle = {
	id: "claude",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: false,
	get defaultPromptGutter(): string {
		return isAsciiPreset() ? "> " : "❯ ";
	},

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return renderTopRule(ctx);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [padding(this.sideChromeWidth(ctx.paddingX)) + ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},
};
