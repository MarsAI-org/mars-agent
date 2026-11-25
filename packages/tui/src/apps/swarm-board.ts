/**
 * Live Swarm Board TUI overlay.
 *
 * Renders an Antigravity-style dynamic swarm session:
 * - Header bar with swarm title and live roster/post counts
 * - Left roster panel (coordinator + workers with state badges, model, worktree tag)
 * - Right split panel with the shared numbered message board (`@mentions` & `[done]`
 *   highlighted, auto-scrolling to newest) and the selected member's live output tail
 * - Narrow terminals (`< 90` columns) stack the three panes vertically
 *
 * Keys:
 * - `Tab` / `Shift+Tab`: switch focus between Roster, Board, and Output
 * - `↑` / `↓` (plus `j`/`k`/`PgUp`/`PgDn`/`Home`/`End` in Board & Output): navigate or scroll
 * - `k` (in Roster) or `K` (anywhere): kill the selected worker
 * - `Ctrl+X`: stop the entire swarm and close the board
 * - `q` / `Esc`: detach and close the board while keeping the swarm running
 */

import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { chatTranscriptDisplayPreferences, type LayoutDensity } from "../chat/display-preferences";
import { matchesKey } from "../keys";
import { sanitizeDisplayWarning, shortenPath } from "../render/render-utils";
import { padToWidth } from "../render/utils";
import { ProcessTerminal } from "../terminal";
import { ensureThemeSync, fgOrPlain, type ThemeColor, theme } from "../theme";
import { type Component, TUI } from "../tui";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";

export type SwarmMemberState = "working" | "waiting" | "stopped" | "killed";

export interface SwarmBoardMemberSnapshot {
	readonly name: string;
	readonly role: "coordinator" | "worker";
	readonly state: SwarmMemberState;
	readonly model: string;
	readonly workspace: "inherit" | "worktree";
	readonly currentActivity?: string;
	readonly lastPostSeq?: number;
	readonly outputTail: readonly string[];
	readonly tokens?: number;
}

export interface SwarmBoardMessageSnapshot {
	readonly seq: number;
	readonly agent: string;
	readonly text: string;
	readonly time: string;
	readonly mentions: readonly string[];
}

export interface SwarmBoardSnapshot {
	readonly swarmId: string;
	readonly title: string;
	readonly members: readonly SwarmBoardMemberSnapshot[];
	readonly messages: readonly SwarmBoardMessageSnapshot[];
}

export interface SwarmBoardCallbacks {
	readonly snapshot: () => SwarmBoardSnapshot;
	readonly killWorker?: (name: string) => void;
	readonly stopAll?: () => void;
	readonly detach: () => void;
}

export interface SwarmBoardOptions {
	/** Refresh cadence in milliseconds for live snapshots and spinner frames. */
	readonly tickMs?: number;
	/** Layout density override; defaults to {@link chatTranscriptDisplayPreferences.density}. */
	readonly density?: LayoutDensity;
}

type FocusPane = "roster" | "board" | "output";

const FOCUS_ORDER: readonly FocusPane[] = ["roster", "board", "output"];
const DEFAULT_TICK_MS = 180;
const WIDE_MIN_COLUMNS = 90;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const MENTION_AND_DONE_RE = /(@[a-zA-Z0-9_-]+|\[done\])/g;

const EMPTY_SNAPSHOT: SwarmBoardSnapshot = {
	swarmId: "",
	title: "Swarm",
	members: [],
	messages: [],
};

/** Neutralize tabs, control characters, ANSI sequences, and home paths. */
function cleanText(value: string | undefined): string {
	if (!value) return "";
	return sanitizeDisplayWarning(replaceTabs(shortenPath(value)));
}

/** Paint `text` with a theme color, degrading cleanly when theme is uninitialized. */
function paint(color: ThemeColor, text: string): string {
	return fgOrPlain(color, text);
}

/** Paint bold `text` with a theme color, degrading cleanly when theme is uninitialized. */
function paintBold(color: ThemeColor, text: string): string {
	return typeof theme === "undefined" ? text : theme.bold(theme.fg(color, text));
}

/** Paint a selected row background with fallback when theme is uninitialized. */
function paintSelectedRow(content: string, width: number): string {
	if (typeof theme === "undefined") return padToWidth(content, width);
	return padToWidth(content, width, s => theme.bg("selectedBg", s));
}

/** Active symbol-preset rounded box glyphs with plain Unicode fallback. */
function boxGlyphs(): {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
} {
	if (typeof theme !== "undefined") return theme.boxRound;
	return {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	};
}

/** Compact token formatting (`12.3k`). */
function compactTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Shorten a provider/model identifier so it fits cleanly in the roster sidebar. */
function shortModel(model: string): string {
	const cleaned = cleanText(model);
	const slash = cleaned.lastIndexOf("/");
	return slash >= 0 && slash < cleaned.length - 1 ? cleaned.slice(slash + 1) : cleaned;
}

function isAsciiPreset(): boolean {
	return typeof theme !== "undefined" && theme.getSymbolPreset() === "ascii";
}

/** Render state badge glyph + color for a swarm member. */
function memberBadge(
	state: SwarmMemberState,
	spinnerIndex: number,
): { glyph: string; label: string; color: ThemeColor } {
	const ascii = isAsciiPreset();
	switch (state) {
		case "working": {
			const frames =
				typeof theme !== "undefined" && theme.spinnerFrames.length > 0 ? theme.spinnerFrames : SPINNER_FRAMES;
			return {
				glyph: frames[spinnerIndex % frames.length] ?? (ascii ? "*" : "●"),
				label: "working",
				color: "accent",
			};
		}
		case "waiting":
			return { glyph: ascii ? "o" : "○", label: "waiting", color: "muted" };
		case "stopped":
			return { glyph: ascii ? "#" : "■", label: "stopped", color: "warning" };
		case "killed":
			return { glyph: ascii ? "x" : "×", label: "killed", color: "error" };
	}
}

/** Highlight `@mentions` in `accent` and `[done]` in `success` within already-sanitized text. */
function highlightMessageTokens(line: string): string {
	let result = "";
	let lastIndex = 0;
	for (const match of line.matchAll(MENTION_AND_DONE_RE)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			result += line.slice(lastIndex, index);
		}
		const token = match[0];
		if (token === "[done]") {
			result += paintBold("success", token);
		} else {
			result += paintBold("accent", token);
		}
		lastIndex = index + token.length;
	}
	if (lastIndex < line.length) {
		result += line.slice(lastIndex);
	}
	return result;
}

/** Wrap a plain sanitized string into lines that each fit within `maxWidth` visible columns. */
function wrapPlainLines(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [""];
	const paragraphs = text.split("\n");
	const out: string[] = [];
	for (const rawParagraph of paragraphs) {
		const paragraph = cleanText(rawParagraph);
		if (paragraph.length === 0) {
			out.push("");
			continue;
		}
		const wrapped = Bun.wrapAnsi(paragraph, maxWidth, { wordWrap: true, hard: true, trim: false });
		for (const segment of wrapped.split("\n")) {
			out.push(truncateToWidth(segment, maxWidth, ""));
		}
	}
	return out.length > 0 ? out : [""];
}

/** Draw a bordered box of exact dimensions `boxWidth` x `boxHeight` (`>= 2`). */
function renderBox(
	title: string,
	rightLabel: string,
	contentLines: readonly string[],
	boxWidth: number,
	boxHeight: number,
	focused: boolean,
): string[] {
	const box = boxGlyphs();
	const border = (s: string) => paint(focused ? "borderAccent" : "borderMuted", s);
	if (boxWidth <= 0 || boxHeight <= 0) return [];
	if (boxWidth < 2) return Array.from({ length: boxHeight }, () => border(box.vertical));

	const innerW = boxWidth - 2;
	const innerH = Math.max(0, boxHeight - 2);

	const cleanTitle = ` ${title} `;
	const cleanRight = rightLabel ? ` ${rightLabel} ` : "";
	const rightW = visibleWidth(cleanRight);
	const maxTitleW = Math.max(0, innerW - rightW - 2);
	const fittedTitle = truncateToWidth(cleanTitle, maxTitleW);
	const titleW = visibleWidth(fittedTitle);
	const fillW = Math.max(0, innerW - titleW - rightW);
	const topBar =
		border(box.topLeft) +
		(focused ? paintBold("accent", fittedTitle) : paint("muted", fittedTitle)) +
		border(box.horizontal.repeat(fillW)) +
		(cleanRight ? paint("dim", truncateToWidth(cleanRight, innerW - titleW)) : "") +
		border(box.topRight);

	const rows: string[] = [truncateToWidth(topBar, boxWidth, "")];
	for (let i = 0; i < innerH; i++) {
		const line = contentLines[i] ?? "";
		rows.push(border(box.vertical) + padToWidth(line, innerW) + border(box.vertical));
	}
	if (boxHeight >= 2) {
		rows.push(border(box.bottomLeft) + border(box.horizontal.repeat(innerW)) + border(box.bottomRight));
	}
	return rows.slice(0, boxHeight);
}

/** Live TUI overlay for dynamic multi-agent swarm sessions. */
export class SwarmBoardComponent implements Component {
	readonly #ui: TUI;
	readonly #callbacks: SwarmBoardCallbacks;
	readonly #tickMs: number;
	readonly #done = Promise.withResolvers<void>();
	#snapshot: SwarmBoardSnapshot = EMPTY_SNAPSHOT;
	#focus: FocusPane = "roster";
	#selectedIndex = 0;
	#selectedName: string | undefined;
	#boardScroll = 0;
	#boardPinned = true;
	#boardMaxScroll = 0;
	#outputScroll = 0;
	#outputPinned = true;
	#outputMaxScroll = 0;
	#spinnerIndex = 0;
	#tick: NodeJS.Timeout | undefined;
	#disposed = false;
	#density: LayoutDensity | undefined;

	constructor(ui: TUI, callbacks: SwarmBoardCallbacks, options?: SwarmBoardOptions) {
		this.#ui = ui;
		this.#callbacks = callbacks;
		this.#tickMs = options?.tickMs ?? DEFAULT_TICK_MS;
		this.#density = options?.density;
	}

	setDensity(density: LayoutDensity | undefined): void {
		if (this.#density === density) return;
		this.#density = density;
		this.#ui.requestRender();
	}

	#effectiveDensity(): LayoutDensity {
		return this.#density ?? chatTranscriptDisplayPreferences.density;
	}

	/** Pull the initial snapshot and start periodic live refresh until closed. */
	run(): Promise<void> {
		this.refresh();
		this.#tick = setInterval(() => {
			this.#spinnerIndex = (this.#spinnerIndex + 1) % 0x7fff_ffff;
			this.refresh();
		}, this.#tickMs);
		return this.#done.promise;
	}

	/** Pull a fresh snapshot from the host callbacks and repaint. */
	refresh(): void {
		if (this.#disposed) return;
		const next = this.#callbacks.snapshot();
		this.#snapshot = next;
		const members = next.members;
		if (members.length === 0) {
			this.#selectedIndex = 0;
			this.#selectedName = undefined;
		} else if (this.#selectedName !== undefined) {
			const idx = members.findIndex(member => member.name === this.#selectedName);
			if (idx >= 0) {
				this.#selectedIndex = idx;
			} else {
				this.#selectedIndex = Math.min(this.#selectedIndex, members.length - 1);
				this.#selectedName = members[this.#selectedIndex]?.name;
			}
		} else {
			this.#selectedIndex = Math.min(this.#selectedIndex, members.length - 1);
			this.#selectedName = members[this.#selectedIndex]?.name;
		}
		this.#ui.requestRender();
	}

	invalidate(): void {
		this.#ui.requestRender();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#tick) clearInterval(this.#tick);
		this.#tick = undefined;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;

		if (matchesKey(data, "tab")) {
			const next = (FOCUS_ORDER.indexOf(this.#focus) + 1) % FOCUS_ORDER.length;
			this.#focus = FOCUS_ORDER[next] ?? "roster";
			this.#ui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			const prev = (FOCUS_ORDER.indexOf(this.#focus) - 1 + FOCUS_ORDER.length) % FOCUS_ORDER.length;
			this.#focus = FOCUS_ORDER[prev] ?? "roster";
			this.#ui.requestRender();
			return;
		}

		if (data === "q" || matchesKey(data, "escape")) {
			this.#callbacks.detach();
			this.#close();
			return;
		}

		if (matchesKey(data, "ctrl+x") || matchesKey(data, "ctrl+c")) {
			if (this.#callbacks.stopAll) {
				this.#callbacks.stopAll();
			} else {
				this.#callbacks.detach();
			}
			this.#close();
			return;
		}

		// Uppercase K kills the selected worker from any focus pane; lowercase k kills when Roster is focused.
		if (data === "K" || (data === "k" && this.#focus === "roster")) {
			this.#killSelectedWorker();
			return;
		}

		if (this.#focus === "roster") {
			this.#handleRosterInput(data);
		} else if (this.#focus === "board") {
			this.#handleScrollInput(data, "board");
		} else {
			this.#handleScrollInput(data, "output");
		}
	}

	#handleRosterInput(data: string): void {
		const members = this.#snapshot.members;
		if (members.length === 0) return;

		if (matchesKey(data, "down") || data === "j") {
			this.#selectMember((this.#selectedIndex + 1) % members.length);
			return;
		}
		if (matchesKey(data, "up")) {
			this.#selectMember((this.#selectedIndex - 1 + members.length) % members.length);
			return;
		}
		if (matchesKey(data, "home")) {
			this.#selectMember(0);
			return;
		}
		if (matchesKey(data, "end")) {
			this.#selectMember(members.length - 1);
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < members.length) {
				this.#selectMember(index);
			}
		}
	}

	#handleScrollInput(data: string, pane: "board" | "output"): void {
		const pageStep = Math.max(3, Math.floor(Math.max(8, this.#ui.terminal.rows) / 3));
		if (matchesKey(data, "up") || data === "k") {
			this.#adjustScroll(pane, -1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#adjustScroll(pane, 1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.#adjustScroll(pane, -pageStep);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.#adjustScroll(pane, pageStep);
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.#setScroll(pane, 0);
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.#pinToBottom(pane);
		}
	}

	#selectMember(index: number): void {
		const members = this.#snapshot.members;
		if (members.length === 0) return;
		const clamped = Math.max(0, Math.min(index, members.length - 1));
		this.#selectedIndex = clamped;
		this.#selectedName = members[clamped]?.name;
		this.#outputScroll = 0;
		this.#outputPinned = true;
		this.#ui.requestRender();
	}

	#adjustScroll(pane: "board" | "output", delta: number): void {
		if (pane === "board") {
			const base = this.#boardPinned ? this.#boardMaxScroll : this.#boardScroll;
			const next = Math.max(0, Math.min(this.#boardMaxScroll, base + delta));
			this.#boardScroll = next;
			this.#boardPinned = next >= this.#boardMaxScroll;
		} else {
			const base = this.#outputPinned ? this.#outputMaxScroll : this.#outputScroll;
			const next = Math.max(0, Math.min(this.#outputMaxScroll, base + delta));
			this.#outputScroll = next;
			this.#outputPinned = next >= this.#outputMaxScroll;
		}
		this.#ui.requestRender();
	}

	#setScroll(pane: "board" | "output", offset: number): void {
		if (pane === "board") {
			this.#boardScroll = Math.max(0, Math.min(this.#boardMaxScroll, offset));
			this.#boardPinned = this.#boardScroll >= this.#boardMaxScroll;
		} else {
			this.#outputScroll = Math.max(0, Math.min(this.#outputMaxScroll, offset));
			this.#outputPinned = this.#outputScroll >= this.#outputMaxScroll;
		}
		this.#ui.requestRender();
	}

	#pinToBottom(pane: "board" | "output"): void {
		if (pane === "board") {
			this.#boardPinned = true;
			this.#boardScroll = this.#boardMaxScroll;
		} else {
			this.#outputPinned = true;
			this.#outputScroll = this.#outputMaxScroll;
		}
		this.#ui.requestRender();
	}

	#killSelectedWorker(): void {
		const selected = this.#snapshot.members[this.#selectedIndex];
		if (!selected || selected.role !== "worker" || selected.state === "killed") return;
		this.#callbacks.killWorker?.(selected.name);
		this.refresh();
	}

	#close(): void {
		this.dispose();
		this.#done.resolve();
	}

	render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		const safeWidth = Math.max(10, renderWidth);
		const height = Math.max(12, this.#ui.terminal.rows);
		const header = this.#renderHeader(safeWidth);
		const rule = paint("borderMuted", boxGlyphs().horizontal.repeat(safeWidth));
		const footer = this.#renderFooter(safeWidth);
		const bodyHeight = Math.max(6, height - 3);

		const body =
			safeWidth >= WIDE_MIN_COLUMNS
				? this.#renderWideBody(safeWidth, bodyHeight)
				: this.#renderNarrowBody(safeWidth, bodyHeight);

		const lines = [header, rule, ...body, footer];
		while (lines.length < height) lines.push("");
		return lines.slice(0, height).map(line => truncateToWidth(line, renderWidth, ""));
	}

	#renderHeader(width: number): string {
		const members = this.#snapshot.members;
		const workers = members.filter(member => member.role === "worker");
		const working = members.filter(member => member.state === "working").length;
		const waiting = members.filter(member => member.state === "waiting").length;
		const posts = this.#snapshot.messages.length;

		const statsParts: string[] = [
			paint("muted", `${workers.length} ${workers.length === 1 ? "worker" : "workers"}`),
			working > 0 ? paint("accent", `${working} working`) : paint("dim", "0 working"),
			paint("muted", `${waiting} waiting`),
			paint("dim", `#${posts} ${posts === 1 ? "post" : "posts"}`),
		];
		const right = statsParts.join(paint("dim", " · "));
		const prefix = ` ${paintBold("accent", "swarm")} ${paint("dim", "·")} `;
		const titleText = cleanText(this.#snapshot.title || this.#snapshot.swarmId || "live session");
		const rightW = visibleWidth(right);
		const prefixW = visibleWidth(prefix);
		const titleBudget = Math.max(4, width - prefixW - rightW - 3);
		const left = prefix + paintBold("text", truncateToWidth(titleText, titleBudget));
		const gap = Math.max(1, width - visibleWidth(left) - rightW - 1);
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
	}

	#renderFooter(width: number): string {
		const selected = this.#snapshot.members[this.#selectedIndex];
		const canKill = Boolean(
			this.#callbacks.killWorker && selected && selected.role === "worker" && selected.state !== "killed",
		);
		const parts: string[] = [
			`${formatKeyHint("tab")} focus (${this.#focus})`,
			`${formatKeyHints(["up", "down"])} ${this.#focus === "roster" ? "select" : "scroll"}`,
		];
		if (this.#focus !== "roster") {
			parts.push(`${formatKeyHints(["pageUp", "pageDown"])} page`);
			parts.push("g/G top/end");
		}
		if (canKill) {
			parts.push(`${this.#focus === "roster" ? "k" : "K"} kill ${cleanText(selected?.name)}`);
		}
		if (this.#callbacks.stopAll) {
			parts.push(`${formatKeyHint("ctrl+x")} stop all`);
		}
		parts.push(`${formatKeyHints(["q", "escape"])} close`);
		return truncateToWidth(paint("dim", ` ${parts.join(" · ")}`), width, "");
	}

	#renderWideBody(width: number, bodyHeight: number): string[] {
		const rosterW = Math.min(32, Math.max(28, Math.floor(width * 0.27)));
		const rightW = Math.max(24, width - rosterW - 1);
		const boardH = Math.max(5, Math.ceil(bodyHeight * 0.6));
		const outputH = Math.max(4, bodyHeight - boardH);

		const rosterBox = this.#renderRosterBox(rosterW, bodyHeight);
		const boardBox = this.#renderBoardBox(rightW, boardH);
		const outputBox = this.#renderOutputBox(rightW, outputH);
		const rightColumn = [...boardBox, ...outputBox];

		const lines: string[] = [];
		for (let i = 0; i < bodyHeight; i++) {
			const left = rosterBox[i] ?? " ".repeat(rosterW);
			const right = rightColumn[i] ?? " ".repeat(rightW);
			lines.push(truncateToWidth(`${left} ${right}`, width, ""));
		}
		return lines;
	}

	#renderNarrowBody(width: number, bodyHeight: number): string[] {
		const rosterH = Math.min(
			Math.max(4, this.#snapshot.members.length + 2),
			Math.max(4, Math.floor(bodyHeight * 0.28)),
		);
		const remaining = Math.max(4, bodyHeight - rosterH);
		const boardH = Math.max(3, Math.ceil(remaining * 0.56));
		const outputH = Math.max(2, remaining - boardH);

		return [
			...this.#renderRosterBox(width, rosterH),
			...this.#renderBoardBox(width, boardH),
			...this.#renderOutputBox(width, outputH),
		].slice(0, bodyHeight);
	}

	#renderRosterBox(boxWidth: number, boxHeight: number): string[] {
		const innerW = Math.max(1, boxWidth - 2);
		const innerH = Math.max(0, boxHeight - 2);
		const members = this.#snapshot.members;
		const rows: string[] = [];

		if (members.length === 0) {
			rows.push(paint("dim", " No members yet…"));
			return renderBox("Roster", "0", rows, boxWidth, boxHeight, this.#focus === "roster");
		}

		// Determine if we have room for two lines per member (primary + model/activity meta).
		const compact = this.#effectiveDensity() === "compact";
		const twoLine = !compact && innerH >= members.length * 2 && innerW >= 20;
		const linesPerMember = twoLine ? 2 : 1;
		const maxVisibleMembers = Math.max(1, Math.floor(innerH / linesPerMember));

		let startIndex = 0;
		if (this.#selectedIndex >= maxVisibleMembers) {
			startIndex = Math.min(members.length - maxVisibleMembers, this.#selectedIndex - maxVisibleMembers + 1);
		}
		const visibleMembers = members.slice(startIndex, startIndex + maxVisibleMembers);

		const ascii = isAsciiPreset();
		for (let i = 0; i < visibleMembers.length; i++) {
			const member = visibleMembers[i];
			if (!member) continue;
			const actualIndex = startIndex + i;
			const isSelected = actualIndex === this.#selectedIndex;
			const badge = memberBadge(member.state, this.#spinnerIndex);
			const cursor = isSelected ? paintBold("accent", ascii ? ">" : "❯") : " ";
			const name = cleanText(member.name);
			const paintedName = isSelected
				? paintBold("accent", name)
				: member.role === "coordinator"
					? paintBold("statusLineModel", name)
					: paint("text", name);
			const wtTag = member.workspace === "worktree" ? ` ${paint("warning", "wt")}` : "";
			const stateChip = paint(badge.color, badge.glyph);

			if (twoLine) {
				const seqTag = member.lastPostSeq !== undefined ? paint("dim", `#${member.lastPostSeq}`) : "";
				const left = `${cursor}${stateChip} ${paintedName}${wtTag}`;
				const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(seqTag) - 1);
				const primary = seqTag
					? truncateToWidth(`${left}${" ".repeat(gap)}${seqTag}`, innerW)
					: truncateToWidth(left, innerW);
				rows.push(isSelected ? paintSelectedRow(primary, innerW) : primary);

				const metaBits: string[] = [paint(badge.color, badge.label)];
				const model = shortModel(member.model);
				if (model) metaBits.push(paint("dim", model));
				if (member.tokens !== undefined) metaBits.push(paint("dim", compactTokens(member.tokens)));
				const metaLine = truncateToWidth(`   ${metaBits.join(paint("dim", " · "))}`, innerW);
				rows.push(isSelected ? paintSelectedRow(metaLine, innerW) : metaLine);
			} else {
				const model = shortModel(member.model);
				const suffix = model ? ` ${paint("dim", model)}` : "";
				const line = truncateToWidth(`${cursor}${stateChip} ${paintedName}${wtTag}${suffix}`, innerW);
				rows.push(isSelected ? paintSelectedRow(line, innerW) : line);
			}
		}

		const countLabel = `${members.length}`;
		return renderBox("Roster", countLabel, rows, boxWidth, boxHeight, this.#focus === "roster");
	}

	#renderBoardBox(boxWidth: number, boxHeight: number): string[] {
		const innerW = Math.max(1, boxWidth - 2);
		const innerH = Math.max(0, boxHeight - 2);
		const messages = this.#snapshot.messages;
		const allLines: string[] = [];

		if (messages.length === 0) {
			allLines.push(paint("dim", " Board is empty — waiting for posts…"));
		} else {
			const textW = Math.max(8, innerW - 3);
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				if (!msg) continue;
				const seqStr = paintBold("accent", `#${msg.seq}`);
				const senderColor: ThemeColor = msg.agent === "coordinator" ? "statusLineModel" : "success";
				const senderStr = paintBold(senderColor, cleanText(msg.agent));
				const timeStr = msg.time ? paint("dim", cleanText(msg.time)) : "";
				const headerLeft = ` ${seqStr} ${senderStr}`;
				const headerLine = timeStr
					? `${headerLeft}${" ".repeat(Math.max(1, innerW - visibleWidth(headerLeft) - visibleWidth(timeStr) - 1))}${timeStr}`
					: headerLeft;
				allLines.push(truncateToWidth(headerLine, innerW));

				const wrapped = wrapPlainLines(msg.text, textW);
				for (const wrappedLine of wrapped) {
					allLines.push(truncateToWidth(`   ${highlightMessageTokens(wrappedLine)}`, innerW));
				}
				if (this.#effectiveDensity() !== "compact" && i < messages.length - 1) {
					allLines.push("");
				}
			}
		}

		this.#boardMaxScroll = Math.max(0, allLines.length - innerH);
		if (this.#boardPinned) {
			this.#boardScroll = this.#boardMaxScroll;
		} else {
			this.#boardScroll = Math.max(0, Math.min(this.#boardScroll, this.#boardMaxScroll));
		}

		const slice = allLines.slice(this.#boardScroll, this.#boardScroll + innerH);
		const scrollTag = this.#boardMaxScroll > 0 && !this.#boardPinned ? "scrolled" : `#${messages.length}`;
		return renderBox("Board", scrollTag, slice, boxWidth, boxHeight, this.#focus === "board");
	}

	#renderOutputBox(boxWidth: number, boxHeight: number): string[] {
		const innerW = Math.max(1, boxWidth - 2);
		const innerH = Math.max(0, boxHeight - 2);
		const selected = this.#snapshot.members[this.#selectedIndex];

		if (!selected) {
			return renderBox(
				"Output",
				"",
				[paint("dim", " No member selected.")],
				boxWidth,
				boxHeight,
				this.#focus === "output",
			);
		}

		const badge = memberBadge(selected.state, this.#spinnerIndex);
		const allLines: string[] = [];

		if (selected.currentActivity) {
			const act = cleanText(selected.currentActivity);
			const actIcon = isAsciiPreset() ? "*" : "⚙";
			allLines.push(truncateToWidth(` ${paint("accent", `${actIcon} ${act}`)}`, innerW));
		}

		const wrapW = Math.max(8, innerW - 2);
		if (selected.outputTail.length === 0) {
			if (!selected.currentActivity) {
				allLines.push(paint("dim", ` ${badge.label} — no output yet.`));
			}
		} else {
			for (const rawLine of selected.outputTail) {
				for (const wrappedLine of wrapPlainLines(rawLine, wrapW)) {
					allLines.push(truncateToWidth(` ${paint("muted", wrappedLine)}`, innerW));
				}
			}
		}

		this.#outputMaxScroll = Math.max(0, allLines.length - innerH);
		if (this.#outputPinned) {
			this.#outputScroll = this.#outputMaxScroll;
		} else {
			this.#outputScroll = Math.max(0, Math.min(this.#outputScroll, this.#outputMaxScroll));
		}

		const slice = allLines.slice(this.#outputScroll, this.#outputScroll + innerH);
		const titleBits = [`Output · ${cleanText(selected.name)}`];
		const rightBits = [badge.label];
		if (selected.workspace === "worktree") rightBits.push("wt");
		const model = shortModel(selected.model);
		if (model) rightBits.push(model);
		if (selected.tokens !== undefined) rightBits.push(compactTokens(selected.tokens));
		if (this.#outputMaxScroll > 0 && !this.#outputPinned) rightBits.push("scrolled");

		return renderBox(
			titleBits.join(" "),
			rightBits.join(" · "),
			slice,
			boxWidth,
			boxHeight,
			this.#focus === "output",
		);
	}
}

/** Mount the live swarm board fullscreen and resolve when the user detaches or stops. */
export async function runSwarmBoard(callbacks: SwarmBoardCallbacks, options?: SwarmBoardOptions): Promise<void> {
	ensureThemeSync();
	const ui = new TUI(new ProcessTerminal());
	const component = new SwarmBoardComponent(ui, callbacks, options);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
