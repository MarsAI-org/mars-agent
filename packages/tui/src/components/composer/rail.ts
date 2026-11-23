/**
 * Filled composer with one strong accent rail on the left. The asymmetric
 * silhouette separates input from transcript without enclosing it in a box.
 */
import { theme } from "../../theme/theme";
import { padding } from "../../utils";
import type { ComposerRowContext, ComposerStyle } from "./types";

const ACCENT_RAIL = "▎";

function isAsciiChrome(ctx: ComposerRowContext): boolean {
	return ctx.box.vertical === "|" || (typeof theme !== "undefined" && theme.getSymbolPreset() === "ascii");
}

/** Filled composer surface anchored by a single left accent rail. */
export const railComposerStyle: ComposerStyle = {
	id: "rail",
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
		const rail = ctx.accentColor(ascii ? "|" : ACCENT_RAIL);
		const leftFill = padding(ctx.paddingX) + ctx.gutter + ctx.text;
		if (ctx.imeSafeCursorTail) return [rail + ctx.surfaceColor(leftFill)];

		const rightFillCells = Math.max(0, ctx.paddingX + 1 - ctx.cursorOverflow);
		if (ctx.scrollbarThumb && rightFillCells > 0) {
			const interior = leftFill + ctx.pad + padding(rightFillCells - 1);
			return [rail + ctx.surfaceColor(interior) + ctx.accentColor(ascii ? "#" : "█")];
		}
		return [rail + ctx.surfaceColor(leftFill + ctx.pad + padding(rightFillCells))];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
