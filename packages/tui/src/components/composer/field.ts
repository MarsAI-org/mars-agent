/**
 * Compact filled composer: every input row is a one-line field with accent end
 * caps and a subtle surface fill. The complete status line remains below it.
 */
import { theme } from "../../theme/theme";
import { padding } from "../../utils";
import type { ComposerRowContext, ComposerStyle } from "./types";

const LEFT_CAP = "▐";
const RIGHT_CAP = "▌";

function isAsciiChrome(ctx: ComposerRowContext): boolean {
	return ctx.box.vertical === "|" || (typeof theme !== "undefined" && theme.getSymbolPreset() === "ascii");
}

/** One-row filled field with accent caps. */
export const fieldComposerStyle: ComposerStyle = {
	id: "field",
	filledSurface: true,
	sideBorders: true,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: true,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 1;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX + 1;
	},

	renderTop(): undefined {
		return undefined;
	},

	renderRow(ctx: ComposerRowContext): string[] {
		const ascii = isAsciiChrome(ctx);
		const left = ctx.accentColor(ascii ? "|" : LEFT_CAP);
		const leftFill = padding(ctx.paddingX) + ctx.gutter + ctx.text;
		if (ctx.imeSafeCursorTail) return [left + ctx.surfaceColor(leftFill)];

		const rightChromeCells = Math.max(1, ctx.paddingX + 1 - ctx.cursorOverflow);
		const interior = leftFill + ctx.pad + padding(rightChromeCells - 1);
		const rightGlyph = ctx.scrollbarThumb ? (ascii ? "#" : "█") : ascii ? "|" : RIGHT_CAP;
		return [left + ctx.surfaceColor(interior) + ctx.accentColor(rightGlyph)];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
