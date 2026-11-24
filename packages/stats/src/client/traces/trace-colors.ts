/**
 * Canvas palette for the trace flamegraph, resolved from the dashboard's CSS
 * design tokens so canvas drawing follows the active theme.
 */

import { useEffect, useMemo, useState } from "react";
import type { TraceSpanKind } from "../types";
import { useSystemTheme } from "../useSystemTheme";

export interface TraceTheme {
	/** Span fill per category. */
	category: Record<TraceSpanKind, string>;
	/** Error left-edge accent. */
	error: string;
	/** Error fill tint. */
	errorSoft: string;
	/** Marker diamond fill. */
	marker: string;
	/** Alternating turn-band fill. */
	turnBand: string;
	/** Ruler/lane hairlines. */
	grid: string;
	/** Ruler tick labels. */
	tick: string;
	/** Span label text drawn inside blocks. */
	spanText: string;
	/** Selection outline / minimap brush. */
	selection: string;
	/** Minimap brush fill. */
	brush: string;
	/** Canvas font stacks. */
	fontSans: string;
	fontMono: string;
}

/** CSS custom property backing each category (also used by DOM chips). */
export const CATEGORY_VARS: Record<TraceSpanKind, string> = {
	turn: "--ink-2",
	model: "--chart-primary",
	tool: "--warn",
	subagent: "--chart-secondary",
	background: "--ink-4",
};

function readTheme(): TraceTheme {
	const style = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	return {
		category: {
			turn: v(CATEGORY_VARS.turn, "#c2bab2"),
			model: v(CATEGORY_VARS.model, "#ff825c"),
			tool: v(CATEGORY_VARS.tool, "#e5b567"),
			subagent: v(CATEGORY_VARS.subagent, "#7ec4b6"),
			background: v(CATEGORY_VARS.background, "#68605c"),
		},
		error: v("--bad", "#f26b6b"),
		errorSoft: v("--bad-soft", "rgba(242, 107, 107, 0.14)"),
		marker: v("--ink-1", "#f5f2ee"),
		turnBand: v("--hover", "rgba(245, 242, 238, 0.04)"),
		grid: v("--chart-grid", "rgba(245, 242, 238, 0.06)"),
		tick: v("--chart-axis", "#8e857e"),
		spanText: v("--ink-inverse", "#161419"),
		selection: v("--focus", "#ff825c"),
		brush: v("--selected", "rgba(255, 130, 92, 0.11)"),
		fontSans: v("--font-sans", "system-ui, sans-serif"),
		fontMono: v("--font-mono", "ui-monospace, monospace"),
	};
}

/**
 * Current trace palette. Re-reads the tokens whenever the resolved theme
 * changes (store or a direct `data-theme` attribute write).
 */
export function useTraceTheme(): TraceTheme {
	const theme = useSystemTheme();
	const [attrVersion, setAttrVersion] = useState(0);
	useEffect(() => {
		const observer = new MutationObserver(() => setAttrVersion(n => n + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: theme/attrVersion are re-read triggers.
	return useMemo(readTheme, [theme, attrVersion]);
}
