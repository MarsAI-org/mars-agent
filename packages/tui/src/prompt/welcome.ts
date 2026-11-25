import { APP_NAME } from "@marsai-org/utils/dirs";
import type { TspSpan } from "@marsai-org/wire";
import { formatDoubleTap, formatKeyHint, formatKeyHints, type KeyName } from "../app-keybindings";
import { chatTranscriptDisplayPreferences, type LayoutDensity } from "../chat/display-preferences";
import { editorKey } from "../chrome/keybinding-hints";
import { getKeybindings, type Keybinding } from "../keybindings";
import { card, col, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import { compactText, plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { isHyperlinkEnabled, urlHyperlink, urlLinkSpan } from "../render/hyperlink";
import { shortenPath } from "../render/render-utils";
import { TERMINAL } from "../terminal-capabilities";
import { theme } from "../theme/theme";
import type { Component } from "../tui";
import { padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import tipsText from "./tips.txt" with { type: "text" };

/** Quick-start command entry displayed in the Mars hardware telemetry block. */
export interface WelcomeQuickCommand {
	readonly command: string;
	readonly label?: string;
}

/** Optional Mars Editorial Instrument telemetry readout for {@link WelcomeComponent}. */
export interface WelcomeTelemetryOptions {
	readonly model?: string;
	readonly provider?: string;
	readonly workspace?: string;
	readonly lspCount?: number;
	readonly mcpCount?: number;
	readonly toolCount?: number;
	readonly quickCommands?: boolean | readonly WelcomeQuickCommand[];
	readonly showSpecRule?: boolean;
	readonly density?: LayoutDensity;
}

/** Default quick-start commands surfaced in the Mars welcome specification sheet. */
export const DEFAULT_WELCOME_QUICK_COMMANDS: readonly WelcomeQuickCommand[] = [
	{ command: "/plan", label: "architect" },
	{ command: "/review", label: "audit" },
	{ command: "/fast", label: "speed" },
	{ command: "?", label: "shortcuts" },
];

/** Leading marker for a tip that pitches Tern: shown only while no TSP surface
 *  is live, since a live one means the user is already in Tern. */
const NO_TERN_TIP_MARKER = /^\[NO-TERN\]\s*/;

/** tips.txt lines embedded at build time; blanks dropped. Key placeholders
 *  (see {@link expandTipKeys}) stay raw until render time. */
const TIP_LINES: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/** Tips for the classic renderer: every tip, {@link NO_TERN_TIP_MARKER} stripped. */
const TIPS: readonly string[] = TIP_LINES.map(line => line.replace(NO_TERN_TIP_MARKER, ""));

/** Tips for a live TSP surface: those marked {@link NO_TERN_TIP_MARKER} dropped. */
const TSP_TIPS: readonly string[] = TIP_LINES.filter(line => !NO_TERN_TIP_MARKER.test(line));

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted as a shimmering rainbow. Non-global so `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. */
const NEW_TAG_TEXT = "NEW!";

/** Milliseconds for one full hue rotation of the rainbow "NEW!" tag. */
const NEW_GLOW_PERIOD_MS = 1500;

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

type ColorEncoding = "ansi-16m" | "ansi-256";

/** Paint each glyph of {@link NEW_TAG_TEXT} on a moving Mars ember ramp. `phase`
 *  shifts the highlight cyclically along terracotta → ember → solar gold so
 *  successive renders shimmer while staying anchored to the brand palette. */
function renderNewTag(phase: number, encoding: ColorEncoding): string {
	const bold = "\x1b[1m";
	const reset = "\x1b[0m";
	const wrapped = ((phase % 1) + 1) % 1;
	const chars = [...NEW_TAG_TEXT];
	let out = bold;
	let prev = "";
	for (let i = 0; i < chars.length; i++) {
		const wave = 0.5 + 0.5 * Math.sin(((i / chars.length + wrapped) % 1) * Math.PI * 2);
		const hue = Math.round(12 + wave * 20);
		const lightness = Math.round((theme.isLight ? 40 : 58) + wave * (theme.isLight ? 12 : 20));
		const color = Bun.color(`hsl(${hue}, 88%, ${lightness}%)`, encoding) ?? "";
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += chars[i];
	}
	return out + reset;
}

/** Key placeholders in tips.txt: `{key:shift+tab}`, `{keys:up,down}`, `{tap:left}`, `{action:tui.editor.undo}`. */
const TIP_KEY_PLACEHOLDER = /\{(key|keys|tap|action):([^}]+)\}/g;

const MODIFIER_NAMES: Record<string, true | undefined> = {
	ctrl: true,
	shift: true,
	alt: true,
	super: true,
};

/** A `+`-joined chord whose leading parts are modifiers (`ctrl+o`, `shift`, `left`). */
function isKeyName(key: string): key is KeyName {
	const parts = key.split("+");
	return parts.every((part, i) => part.length > 0 && (i === parts.length - 1 || MODIFIER_NAMES[part] === true));
}

function isKeybinding(action: string): action is Keybinding {
	return action in getKeybindings().getResolvedBindings();
}

/** Expand tip key placeholders through the key formatter; malformed ones stay verbatim. */
function expandTipKeys(tip: string): string {
	return tip.replace(TIP_KEY_PLACEHOLDER, (placeholder, kind: string, value: string) => {
		if (kind === "action") return isKeybinding(value) ? editorKey(value) : placeholder;
		const keys = value.split(",");
		if (!keys.every(isKeyName)) return placeholder;
		if (kind === "keys") return formatKeyHints(keys);
		const [key] = keys;
		if (key === undefined) return placeholder;
		return kind === "tap" ? formatDoubleTap(key) : formatKeyHint(key);
	});
}

/** Markdown-style links in tips.txt: `[Tern](https://scl.so/tern)` shows the label, linked to the URL. */
const TIP_LINK = /\[([^\]]+)\]\(([^\s)]+)\)/g;

/** Tip links as underlined OSC 8 labels, or `label (url)` where the terminal cannot link. */
function linkTipText(tip: string): string {
	const linkable = isHyperlinkEnabled();
	return tip.replace(TIP_LINK, (_link, label: string, url: string) =>
		linkable ? urlHyperlink(url, theme.underline(label)) : `${label} (${url})`,
	);
}

/** The tip as native text: escapes dropped, links as `href` spans. */
function tipSpans(tip: string): TspSpan[] {
	const spans: TspSpan[] = [];
	let cursor = 0;
	for (const match of tip.matchAll(TIP_LINK)) {
		const [link, label, url] = match;
		if (match.index > cursor) spans.push(span(plainText(tip.slice(cursor, match.index))));
		spans.push(urlLinkSpan(url, label));
		cursor = match.index + link.length;
	}
	if (cursor < tip.length) spans.push(span(plainText(tip.slice(cursor))));
	return spans;
}

/**
 * The welcome tip as lines of at most `width` columns: `Tip:` and the body
 * wrapped together, with no indent, so the banner can center each line.
 * `[]` when `width` leaves no room for a useful line.
 */
export function renderWelcomeTip(tip: string, width: number, phase = 0): string[] {
	const label = "Tip: ";
	if (width - visibleWidth(label) < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = linkTipText(expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip));

	// Trailing spaces left by the wrap would count toward the width the banner centers.
	const wrapped = wrapTextWithAnsi(replaceTabs(`${label}${body}`), width).map(line => line.trimEnd());
	if (wrapped.length === 0) return [];

	// Pull both colors from the active theme so the line stays readable on light
	// themes and harmonizes with the Mars brand accent.
	const styledLabel = theme.fg("accent", label);
	const lines = wrapped.map((line, index) =>
		theme.italic(
			index === 0 && line.startsWith(label)
				? `${styledLabel}${theme.fg("muted", line.slice(label.length))}`
				: theme.fg("muted", line),
		),
	);

	if (isNew) {
		// Append the rainbow tag to the final line when it fits; otherwise give it
		// a line of its own so the styled glyphs never overflow the width.
		const encoding: ColorEncoding = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
		const tag = renderNewTag(phase, encoding);
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= width) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(tag);
		}
	}

	return lines;
}

/**
 * The session's welcome banner. In a terminal: the gradient logo beside the
 * `Mars` wordmark with the version under it (the logo alone when the lockup does
 * not fit) and the tip of the session (dropped below {@link TIP_MIN_COLUMNS}
 * columns). Natively: a card with the same logo, wordmark, version and tip
 * ({@link WelcomeComponent.describe}).
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#requestRender: (() => void) | null = null;
	// Tip randomness is latched once so the tip is stable across renders, but
	// the nerdfont-nag gate re-reads the live preset and the pool re-reads the
	// live TSP state: the startup prepaint can run under the default "unicode"
	// preset before settings resolve the real one, and an optimistic Tern start
	// falls back to the classic renderer when `hello` never confirms.
	#nagRoll: number | undefined;
	#tipRoll: number | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedDensity: LayoutDensity | undefined;
	#cachedLines: string[] | undefined;
	#native: { tip: string | undefined; telemetryKey: string; node: NativeNode } | undefined;
	#telemetry: WelcomeTelemetryOptions | undefined;
	#density: LayoutDensity | undefined;

	constructor(
		private version: string,
		telemetry?: WelcomeTelemetryOptions,
	) {
		this.#telemetry = telemetry;
		this.#density = telemetry?.density;
	}

	get telemetry(): WelcomeTelemetryOptions | undefined {
		return this.#telemetry;
	}

	setTelemetry(telemetry: WelcomeTelemetryOptions | undefined): void {
		this.#telemetry = telemetry;
		if (telemetry?.density !== undefined) this.#density = telemetry.density;
		this.invalidate();
	}

	setDensity(density: LayoutDensity | undefined): void {
		if (this.#density === density) return;
		this.#density = density;
		this.invalidate();
	}

	#effectiveDensity(): LayoutDensity {
		return this.#density ?? this.#telemetry?.density ?? chatTranscriptDisplayPreferences.density;
	}

	get tip(): string | undefined {
		this.#nagRoll ??= Math.random();
		this.#tipRoll ??= Math.random();
		if (theme.getSymbolPreset() === "unicode" && this.#nagRoll < 0.1) {
			return "Please use nerdfont 😭.";
		}
		return pickWeightedTip(isNativeRendering() ? TSP_TIPS : TIPS, this.#tipRoll) || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#native = undefined;
	}

	/**
	 * A `card` (`omp.welcome`) mirroring the terminal banner: the lockup
	 * (`omp.welcome.lockup`: the terminal's builtin Mars mark, which it animates,
	 * beside the wordmark with the version under it) and the tip of the session.
	 * Roles carry the look (gradient logo, type scale); a "[NEW]" tip
	 * carries a terminal-clocked shimmering tag.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const tip = this.tip;
		const telemetryKey = JSON.stringify(this.#telemetry ?? null);
		if (this.#native && this.#native.tip === tip && this.#native.telemetryKey === telemetryKey) {
			return this.#native.node;
		}
		// Brand lines are short and fixed; never wrap or truncate them.
		const art = (spans: readonly TspSpan[], role: string): NativeNode =>
			keyed(text(spans, { wrap: "none", role }), role);
		const lockupRow = keyed(
			row(
				[
					node(
						"image",
						{
							builtin: "mars",
							alt: APP_NAME,
							w: 128,
							role: "omp.welcome.logo",
						},
						undefined,
						"logo",
					),
					keyed(
						col(
							[
								art([span(APP_NAME, "strong")], "omp.welcome.wordmark"),
								art([span(`v${this.version}`, "dim mono")], "omp.welcome.version"),
							],
							{ role: "omp.welcome.mark" },
						),
						"mark",
					),
				],
				{ align: "center", gap: "md", role: "omp.welcome.lockup" },
			),
			"lockup",
		);
		const body: NativeChild[] = [lockupRow];
		if (this.#telemetry) {
			const telemetrySpans = describeWelcomeTelemetrySpans(this.#telemetry);
			if (telemetrySpans.length > 0) {
				body.push(
					keyed(text(compactText(telemetrySpans), { wrap: "word", role: "omp.welcome.telemetry" }), "telemetry"),
				);
			}
			const commandSpans = describeWelcomeCommandSpans(this.#telemetry);
			if (commandSpans.length > 0) {
				body.push(
					keyed(text(compactText(commandSpans), { wrap: "word", role: "omp.welcome.commands" }), "commands"),
				);
			}
		}
		if (tip) {
			const isNew = NEW_TIP_MARKER.test(tip);
			const tipText = compactText(tipSpans(expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip)));
			const tipRow: NativeChild[] = [
				node("icon", { name: "lightbulb", role: "omp.welcome.tip-icon" }),
				text(tipText, { wrap: "word", role: "omp.welcome.tip-text" }),
			];
			if (isNew) tipRow.push(node("shimmer", { text: "New", role: "omp.welcome.new" }));
			body.push(node("row", { gap: "sm", align: "start", role: "omp.welcome.tip" }, tipRow, "tip"));
		}
		// No head row or chevron: the card is the hero; the version sits under the wordmark.
		const described = card({ role: "omp.welcome" }, body);
		this.#native = { tip, telemetryKey, node: described };
		return described;
	}

	/** The intro keeps the welcome block mutable; settling lets it retire to history. */
	isTranscriptBlockFinalized(): boolean {
		return this.#animTimer == null;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		// The intro is a repaint-only gradient sweep; a TSP terminal shows the
		// settled card right away.
		if (isNativeRendering()) {
			requestRender();
			return;
		}
		this.#requestRender = requestRender;
		this.#animStart = performance.now();
		this.#requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			const requestRender = this.#requestRender;
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			// Stopping clears the callback, but the settled frame must still paint
			// so an oversized startup header can retire into native scrollback.
			requestRender?.();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		this.#requestRender = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	/**
	 * Redirect a running intro's render callback to a new target when a host
	 * remounts this component mid-animation.
	 * Returns true while the intro is still animating; false = no-op (settled).
	 */
	retargetIntro(requestRender: () => void): boolean {
		if (this.#animTimer == null) return false;
		this.#requestRender = requestRender;
		return true;
	}

	/** Stop the intro immediately and settle on the resting frame. Safe when idle. */
	stopIntro(): void {
		this.#stopAnimation();
	}

	/** Update the version embedded in the welcome border title. */
	setVersion(version: string): void {
		this.version = version;
		this.invalidate();
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		const density = this.#effectiveDensity();
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth && this.#cachedDensity === density) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth, density);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
			this.#cachedDensity = undefined;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
			this.#cachedDensity = density;
		}
		return lines;
	}

	#renderLines(termWidth: number, density: LayoutDensity): string[] {
		// Content keeps a column clear on each side; everything centers in the full width.
		const room = termWidth - 2;
		if (room < 4) return [];
		const compact = density === "compact";
		const logo = this.#currentLogoFrame(compact);
		const logoWidth = compact ? COMPACT_LOGO_WIDTH : LOGO_WIDTH;
		const version = theme.fg("dim", `v${this.version}`);
		const lockupWidth = logoWidth + LOCKUP_GAP + Math.max(WORDMARK_WIDTH, visibleWidth(version));
		const art = room >= lockupWidth ? lockup(logo, version) : room >= logoWidth ? logo : [];
		const lines = centerBlock(art, termWidth);
		if (this.#telemetry) {
			const telemetryLines = renderWelcomeTelemetry(this.#telemetry, room);
			if (telemetryLines.length > 0) {
				if (!compact) lines.push("");
				lines.push(...telemetryLines.flatMap(line => centerBlock([line], termWidth)));
			}
		}
		const tip = termWidth >= TIP_MIN_COLUMNS ? this.#renderTip(room) : [];
		if (tip.length > 0) {
			if (!compact) lines.push("");
			lines.push(...tip.flatMap(line => centerBlock([line], termWidth)));
		}
		return lines;
	}

	/**
	 * The tip of the session wrapped to {@link TIP_MEASURE} columns (fewer when
	 * `room` is narrower); `[]` when there is none or no room for it.
	 */
	#renderTip(room: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		// A trailing "[NEW]" marker paints an animated rainbow "NEW!" tag. Derive
		// its hue phase from wall-clock time so it shimmers across the welcome
		// intro's re-render frames, then settles into a still rainbow once the
		// banner caches its resting frame. Non-"[NEW]" tips ignore the phase entirely.
		const phase = NEW_TIP_MARKER.test(tip) ? performance.now() / NEW_GLOW_PERIOD_MS : 0;
		return renderWelcomeTip(tip, Math.min(room, TIP_MEASURE), phase);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(compact = false): readonly string[] {
		const restFrame = compact ? REST_FRAME_COMPACT : REST_FRAME;
		if (this.#animStart == null) return restFrame;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return restFrame;
		return introLogoFrame(elapsed / INTRO_MS, compact ? MARS_LOGO_COMPACT : MARS_LOGO);
	}
}

/**
 * Block-grid Mars mark shared by the welcome and setup surfaces: the pixel-art
 * mark from `assets/mars-logo.svg` — the round body, two symmetric eyes, and
 * the two feet — reduced to a 12×12 half-block grid.
 */
export const MARS_LOGO = [
	"  ▄██████▄  ",
	" ██████████ ",
	"███▀████▀███",
	"▀██████████▀",
	" ▀████████▀ ",
	"  ▄█▀▀▀▀█▄  ",
];

/**
 * Five-row form of {@link MARS_LOGO} for short terminals, where the extra row
 * would push a menu item out of the frame. Symmetric 10-column silhouette with
 * two eyes and two feet, sampled from a 10×10 grid.
 */
export const MARS_LOGO_COMPACT = ["  ▄████▄  ", "▄████████▄", "██▀████▀██", " ▀██████▀ ", "  ▄█▀▀█▄  "];

/** Columns of {@link MARS_LOGO} and {@link MARS_LOGO_COMPACT}. */
const LOGO_WIDTH = Math.max(...MARS_LOGO.map(row => row.length));
const COMPACT_LOGO_WIDTH = Math.max(...MARS_LOGO_COMPACT.map(row => row.length));

/**
 * The `MARS` wordmark in half-blocks, set beside {@link MARS_LOGO} from its
 * second row: each letter spans 3 columns with 1-column gaps and the version
 * sits directly beneath.
 */
const WORDMARK = ["█▄█ ▄▀▄ █▀▄ ▄▀▀", "█ █ █▀█ █▀▄ ▀▀▄", "▀ ▀ ▀ ▀ ▀ ▀ ▀▀ "];

/** Columns of {@link WORDMARK}. */
const WORDMARK_WIDTH = Math.max(...WORDMARK.map(row => row.length));

/** Columns between the logo and the wordmark. */
const LOCKUP_GAP = 4;

/** Widest a welcome tip wraps, so a long one stays a centered paragraph. */
const TIP_MEASURE = 72;

/** Narrowest terminal that still shows the tip; below it the banner is the logo alone. */
const TIP_MIN_COLUMNS = 50;

/** Logo frame `logo` with the wordmark beside it and `version` (styled) under the wordmark. */
function lockup(logo: readonly string[], version: string): string[] {
	const beside = ["", ...WORDMARK.map(row => theme.bold(theme.fg("text", row))), version];
	return logo.map((row, index) => {
		const right = beside[index];
		return right ? `${row}${padding(LOCKUP_GAP)}${right}` : row;
	});
}

function sanitizeTelemetryToken(value: string): string {
	return replaceTabs(value.replace(/[\r\n]+/g, " ")).trim();
}

function resolveQuickCommands(quickCommands: WelcomeTelemetryOptions["quickCommands"]): readonly WelcomeQuickCommand[] {
	if (quickCommands === false) return [];
	if (Array.isArray(quickCommands)) return quickCommands;
	if (quickCommands === true) return DEFAULT_WELCOME_QUICK_COMMANDS;
	return [];
}

function describeWelcomeTelemetrySpans(telemetry: WelcomeTelemetryOptions): TspSpan[] {
	const parts: TspSpan[][] = [];
	if (telemetry.model) {
		const modelText = sanitizeTelemetryToken(telemetry.model);
		if (modelText) {
			const group: TspSpan[] = [span(modelText, "accent")];
			if (telemetry.provider) {
				const providerText = sanitizeTelemetryToken(telemetry.provider);
				if (providerText) group.push(span(` (${providerText})`, "dim"));
			}
			parts.push(group);
		}
	}
	if (telemetry.workspace) {
		const wsText = sanitizeTelemetryToken(shortenPath(telemetry.workspace));
		if (wsText) parts.push([span(wsText, "muted")]);
	}
	if (telemetry.lspCount !== undefined) {
		parts.push([span(`${telemetry.lspCount}`, "strong"), span(" LSP", "dim")]);
	}
	if (telemetry.mcpCount !== undefined) {
		parts.push([span(`${telemetry.mcpCount}`, "strong"), span(" MCP", "dim")]);
	}
	if (telemetry.toolCount !== undefined) {
		const noun = telemetry.toolCount === 1 ? " tool" : " tools";
		parts.push([span(`${telemetry.toolCount}`, "strong"), span(noun, "dim")]);
	}
	const out: TspSpan[] = [];
	for (const part of parts) {
		if (out.length > 0) out.push(span(theme.sep.dot, "dim"));
		out.push(...part);
	}
	return out;
}

function describeWelcomeCommandSpans(telemetry: WelcomeTelemetryOptions): TspSpan[] {
	const commands = resolveQuickCommands(telemetry.quickCommands);
	const out: TspSpan[] = [];
	for (const entry of commands) {
		const cmd = sanitizeTelemetryToken(entry.command);
		if (!cmd) continue;
		if (out.length > 0) out.push(span(theme.sep.dot, "dim"));
		out.push(span(cmd, "accent mono"));
		if (entry.label) {
			const label = sanitizeTelemetryToken(entry.label);
			if (label) out.push(span(` ${label}`, "dim"));
		}
	}
	return out;
}

/**
 * Render the Mars "Editorial Instrument" specification rule, telemetry readout
 * (model, workspace, LSP/MCP/tools counts), and quick-start command hints within
 * `width` columns. Adapts responsively from wide single-row bars to stacked
 * narrow-terminal rows.
 */
export function renderWelcomeTelemetry(telemetry: WelcomeTelemetryOptions, width: number): string[] {
	if (width < 12) return [];

	const dot = theme.fg("dim", theme.sep.dot);
	const primaryParts: string[] = [];
	if (telemetry.model) {
		const modelName = sanitizeTelemetryToken(telemetry.model);
		if (modelName) {
			const providerSuffix = telemetry.provider
				? (() => {
						const prov = sanitizeTelemetryToken(telemetry.provider);
						return prov ? theme.fg("dim", ` (${prov})`) : "";
					})()
				: "";
			primaryParts.push(`${theme.fg("accent", modelName)}${providerSuffix}`);
		}
	}
	if (telemetry.workspace) {
		const ws = sanitizeTelemetryToken(shortenPath(telemetry.workspace));
		if (ws) primaryParts.push(theme.fg("muted", ws));
	}

	const countParts: string[] = [];
	if (telemetry.lspCount !== undefined) {
		countParts.push(`${theme.fg("text", String(telemetry.lspCount))} ${theme.fg("dim", "LSP")}`);
	}
	if (telemetry.mcpCount !== undefined) {
		countParts.push(`${theme.fg("text", String(telemetry.mcpCount))} ${theme.fg("dim", "MCP")}`);
	}
	if (telemetry.toolCount !== undefined) {
		const unit = telemetry.toolCount === 1 ? "tool" : "tools";
		countParts.push(`${theme.fg("text", String(telemetry.toolCount))} ${theme.fg("dim", unit)}`);
	}

	const commands = resolveQuickCommands(telemetry.quickCommands);
	const hasContent = primaryParts.length > 0 || countParts.length > 0 || commands.length > 0;
	if (!hasContent && !telemetry.showSpecRule) return [];

	const lines: string[] = [];

	// Editorial specification rule: hairline with a centered Mars glyph.
	if (telemetry.showSpecRule !== false && width >= 20) {
		const ruleSpan = Math.min(width, TIP_MEASURE, 48);
		const glyph = theme.icon.mars || "◆";
		const glyphWidth = visibleWidth(glyph);
		const wing = Math.max(2, Math.floor((ruleSpan - glyphWidth - 2) / 2));
		const bar = theme.fg("borderMuted", theme.boxRound.horizontal.repeat(wing));
		lines.push(truncateToWidth(`${bar} ${theme.fg("accent", glyph)} ${bar}`, width));
	}

	const allTelemetry = [...primaryParts, ...countParts];
	if (allTelemetry.length > 0) {
		const combined = allTelemetry.join(dot);
		if (visibleWidth(combined) <= width) {
			lines.push(combined);
		} else {
			if (primaryParts.length > 0) {
				const primaryLine = primaryParts.join(dot);
				if (visibleWidth(primaryLine) <= width) {
					lines.push(primaryLine);
				} else {
					for (const part of primaryParts) {
						lines.push(truncateToWidth(part, width));
					}
				}
			}
			if (countParts.length > 0) {
				lines.push(truncateToWidth(countParts.join(dot), width));
			}
		}
	}

	if (commands.length > 0 && width >= 16) {
		const fullCommands: string[] = [];
		const compactCommands: string[] = [];
		for (const item of commands) {
			const cmd = sanitizeTelemetryToken(item.command);
			if (!cmd) continue;
			const styledCmd = theme.fg("accent", cmd);
			compactCommands.push(styledCmd);
			const label = item.label ? sanitizeTelemetryToken(item.label) : "";
			fullCommands.push(label ? `${styledCmd} ${theme.fg("dim", label)}` : styledCmd);
		}
		if (fullCommands.length > 0) {
			const fullLine = fullCommands.join(dot);
			const compactLine = compactCommands.join(dot);
			if (visibleWidth(fullLine) <= width) {
				lines.push(fullLine);
			} else if (visibleWidth(compactLine) <= width) {
				lines.push(compactLine);
			} else {
				lines.push(truncateToWidth(compactLine, width));
			}
		}
	}

	return lines;
}

/**
 * `lines` indented as one block whose widest line is centered in `width`
 * columns; pass a single line to center it on its own.
 */
function centerBlock(lines: readonly string[], width: number): string[] {
	const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const indent = padding(Math.max(0, Math.floor((width - widest) / 2)));
	return lines.map(line => indent + line);
}

/** The block-grid brand mark as accent lines; `shimmer` declares the terminal-clocked shine sweep. */
export function logoNode(lines: readonly string[], shimmer: boolean): NativeNode {
	return col(
		lines.map(line =>
			text([span(line, "accent", shimmer ? { fx: "shimmer" } : undefined)], {
				wrap: "none",
			}),
		),
		{ align: "center", role: "omp.setup.logo" },
	);
}

/**
 * Multi-stop palette for the diagonal gradient: the Mars brand ramp from
 * `mars-mark.svg`, moving from Mars Crater through Mars Deep and Mars Orange
 * to Ember Coral and Ember Hover.
 */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[155, 50, 32], // marsCrater #9b3220
	[180, 54, 24], // marsDeep   #b43618
	[214, 74, 39], // marsOrange #d64a27
	[255, 130, 92], // marsEmber  #ff825c
	[255, 160, 130], // emberHover #ffa082
];

/** 256-color ramp fallback when truecolor isn't available: crater → terracotta → ember coral. */
const GRADIENT_RAMP_256 = [88, 130, 166, 202, 209, 216];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (TERMINAL.trueColor) {
		// 5-stop palette widens the visible color range and avoids the
		// deep-blue valley a naive HSL lerp falls into.
		const stops = GRADIENT_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		let r = a[0] + (b[0] - a[0]) * f;
		let g = a[1] + (b[1] - a[1]) * f;
		let bl = a[2] + (b[2] - a[2]) * f;
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const ramp = GRADIENT_RAMP_256;
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (top-left → bottom-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	const xSpan = Math.max(1, cols - 1);
	const ySpan = Math.max(1, rows - 1);
	const normalizedPhase = ((phase % 1) + 1) % 1;
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// SVG's (0,0) → (1,1) gradient projects both normalized axes
			// equally: top-right and bottom-left land on the purple midpoint.
			const base = (x / xSpan + y / ySpan) / 2;
			const t = normalizedPhase === 0 ? base : (base + normalizedPhase) % 1;
			result += gradientEscape(t, shine) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the resting state. The gradient
 * sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` → phase =
 * 0 = resting frame) while the shine traverses the diagonal at a steady pace,
 * decoupled from the gradient phase so the two layers parallax; its strength
 * fades with the same ease-out curve so the highlight is gone by the resting
 * frame.
 */
function introLogoFrame(progress: number, logo: readonly string[] = MARS_LOGO): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
	const shineStrength = (1 - eased) ** 1.5;
	return gradientLogo(logo, phase, {
		strength: shineStrength,
		pos: shinePos,
	});
}

/** Resting gradient frames, cached for re-renders outside of the intro. */
const REST_FRAME = gradientLogo(MARS_LOGO, 0);
const REST_FRAME_COMPACT = gradientLogo(MARS_LOGO_COMPACT, 0);
