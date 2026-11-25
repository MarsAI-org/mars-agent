import type { Component } from "../tui";
import { chatTranscriptDisplayPreferences, type LayoutDensity } from "../chat/display-preferences";
import { getThemeEpoch, type ThemeColor, theme } from "../theme";
import { truncateToWidth } from "../utils";
import { node, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { plainText } from "../native/spans";
import { Memo } from "../native/memo";

/** Presentation policy for a compact message divider. */
export interface MessageDividerOptions {
	/** Theme-aware label, recomputed after invalidation. */
	readonly label: () => string;
	readonly labelColor: ThemeColor;
	readonly ruleColor?: ThemeColor;
	readonly ruleWidth?: number;
	/** Preserve an intentionally untruncated legacy label at very narrow widths. */
	readonly truncateWhenNarrow?: boolean;
	/** Semantic role of the native node. */
	readonly role?: string;
	/**
	 * Draw as an inline notice (this named icon and a one-line label without
	 * the leading glyph) instead of a labelled rule.
	 */
	readonly native?: { readonly icon: string; readonly label: () => string };
}

/**
 * A short left-aligned rule and label surrounded by blank transcript rows.
 * Rendered rows are cached by width and stay reference-stable until invalidated.
 */
export class MessageDividerComponent implements Component {
	readonly #options: MessageDividerOptions;
	#cache: { width: number; density: LayoutDensity; lines: readonly string[] } | undefined;
	readonly #native = new Memo();

	constructor(options: MessageDividerOptions) {
		this.#options = options;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#native.clear();
	}

	/** An inline notice, else a labelled `rule`; the label is theme-aware, so it rebuilds on theme changes. */
	describe(): NativeNode {
		const inline = this.#options.native;
		if (inline) {
			return this.#native.get([getThemeEpoch()], () =>
				node("row", { gap: "sm", role: this.#options.role ?? "omp.divider" }, [
					node("icon", { name: inline.icon }),
					text([span(inline.label(), this.#options.labelColor)], { truncate: "end" }),
				]),
			);
		}
		return this.#native.get([getThemeEpoch()], () =>
			node("rule", {
				role: this.#options.role ?? "omp.divider",
				label: [span(plainText(this.#options.label()), this.#options.labelColor)],
			}),
		);
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const density = chatTranscriptDisplayPreferences.density;
		if (this.#cache?.width === width && this.#cache.density === density) return this.#cache.lines;
		const dividerLine = this.#renderDivider(width);
		const lines = Object.freeze(density === "compact" ? [dividerLine] : ["", dividerLine, ""]);
		this.#cache = { width, density, lines };
		return lines;
	}

	#renderDivider(width: number): string {
		const label = this.#options.label();
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(this.#options.ruleWidth ?? 10, width - labelWidth - 1);
		const paintedLabel = theme.fg(this.#options.labelColor, label);
		if (ruleWidth < 1) {
			return this.#options.truncateWhenNarrow === false ? paintedLabel : truncateToWidth(paintedLabel, width);
		}
		const rule = theme.fg(this.#options.ruleColor ?? "dim", theme.tree.horizontal.repeat(ruleWidth));
		return `${rule} ${paintedLabel}`;
	}
}
