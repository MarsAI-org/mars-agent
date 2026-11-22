/**
 * Orchestrator board: one live pane per worker.
 *
 * The orchestrator runs several agents at once, and a single scrolling log
 * makes it impossible to see which worker is doing what. This board gives every
 * worker its own pane — state, current task, elapsed time, token use, and its
 * latest output — with a wide layout that tiles panes side by side and a narrow
 * layout that shows one at a time.
 *
 * Keys: `tab`/`shift+tab` next/previous worker, `1`–`9` jump to a worker,
 * `l` toggle the wide/narrow layout, `enter` expand the focused pane's output,
 * `q`/`esc`/`ctrl+c` quit.
 */

import { formatDuration } from "@marsai-org/utils";
import chalk from "@marsai-org/utils/chalk";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { matchesKey } from "../keys";
import { ProcessTerminal } from "../terminal";
import { type Component, TUI } from "../tui";
import { truncateToWidth } from "../utils";

/** Lifecycle states a pane can show, mirroring the orchestrator's worker states. */
export type PaneState =
	| "pending"
	| "spawning"
	| "running"
	| "idle"
	| "verifying"
	| "merging"
	| "completed"
	| "failed"
	| "cancelled";

/** Everything the board needs to draw one worker. */
export interface WorkerPane {
	readonly workerId: string;
	/** Role label, e.g. "frontend". Shown as the pane title. */
	readonly label: string;
	readonly state: PaneState;
	/** Task currently assigned, when one is running. */
	readonly taskId?: string;
	readonly taskTitle?: string;
	/** Files this task declared it writes; shown as the pane's scope line. */
	readonly targetFiles?: readonly string[];
	/** Milliseconds since this worker started, when it has. */
	readonly elapsedMs?: number;
	readonly tokens?: number;
	/** Latest output lines, oldest first. The pane shows the tail. */
	readonly output?: readonly string[];
	/** Isolation branch, once the worker committed one. */
	readonly branchName?: string;
	/** Why the worker failed, when it did. */
	readonly error?: string;
}

export interface OrchestratorBoardOptions {
	/** Plan goal, shown in the header. */
	readonly goal: string;
	/** Force the narrow single-pane layout regardless of terminal width. */
	readonly narrow?: boolean;
	/** Refresh cadence for elapsed timers. */
	readonly tickMs?: number;
}

/** Host callbacks: the board renders state, it does not own it. */
export interface OrchestratorBoardHost {
	/** Current snapshot of every worker, polled on each tick. */
	snapshot(): readonly WorkerPane[];
	/** Cancel one worker (not the whole run). */
	cancelWorker?(workerId: string): void;
	/** Stop the whole run and close the board. */
	stopAll(): void;
}

const DEFAULT_TICK_MS = 250;
/** Below this width, tiling panes leaves each too narrow to read. */
const TILE_MIN_COLUMNS = 100;
/** Most panes to tile at once; beyond this the grid is unreadable. */
const MAX_TILED_PANES = 6;
/** Output lines shown in a collapsed pane. */
const PREVIEW_LINES = 4;
/** Output lines shown in an expanded pane. */
const EXPANDED_LINES = 18;

/** Glyph and tone for each state, so a glance reads as a status. */
function stateMark(state: PaneState): { glyph: string; paint: (text: string) => string } {
	switch (state) {
		case "running":
			return { glyph: "▶", paint: text => chalk.green(text) };
		case "spawning":
			return { glyph: "◐", paint: text => chalk.cyan(text) };
		case "verifying":
			return { glyph: "◇", paint: text => chalk.cyan(text) };
		case "merging":
			return { glyph: "⇄", paint: text => chalk.magenta(text) };
		case "completed":
			return { glyph: "✔", paint: text => chalk.green(text) };
		case "failed":
			return { glyph: "✘", paint: text => chalk.red(text) };
		case "cancelled":
			return { glyph: "⊘", paint: text => chalk.yellow(text) };
		case "idle":
			return { glyph: "·", paint: text => chalk.dim(text) };
		default:
			return { glyph: "○", paint: text => chalk.dim(text) };
	}
}

/** `12.3k` style compact counts, so a token figure fits a narrow pane. */
function compactCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export class OrchestratorBoardComponent implements Component {
	readonly #ui: TUI;
	readonly #options: OrchestratorBoardOptions;
	readonly #host: OrchestratorBoardHost;
	readonly #done = Promise.withResolvers<void>();
	#panes: readonly WorkerPane[] = [];
	#focused = 0;
	#wide: boolean;
	#expanded = false;
	#tick: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(ui: TUI, options: OrchestratorBoardOptions, host: OrchestratorBoardHost) {
		this.#ui = ui;
		this.#options = options;
		this.#host = host;
		this.#wide = options.narrow !== true;
	}

	run(): Promise<void> {
		this.#refresh();
		this.#tick = setInterval(() => this.#refresh(), this.#options.tickMs ?? DEFAULT_TICK_MS);
		return this.#done.promise;
	}

	#refresh(): void {
		if (this.#disposed) return;
		const next = this.#host.snapshot();
		// Keep the selection on the same worker across refreshes: panes are
		// re-sorted by activity, so an index would jump.
		const selected = this.#panes[this.#focused]?.workerId;
		this.#panes = next;
		if (selected !== undefined) {
			const index = next.findIndex(pane => pane.workerId === selected);
			if (index >= 0) this.#focused = index;
			else this.#focused = Math.min(this.#focused, Math.max(0, next.length - 1));
		}
		this.#ui.requestRender();
	}

	handleInput(data: string): void {
		const panes = this.#panes;
		if (matchesKey(data, "tab")) {
			if (panes.length > 0) this.#focused = (this.#focused + 1) % panes.length;
			this.#ui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			if (panes.length > 0) this.#focused = (this.#focused - 1 + panes.length) % panes.length;
			this.#ui.requestRender();
			return;
		}
		if (data === "l") {
			this.#wide = !this.#wide;
			this.#ui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.#expanded = !this.#expanded;
			this.#ui.requestRender();
			return;
		}
		if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.#host.stopAll();
			this.dispose();
			this.#done.resolve();
			return;
		}
		// Digit jump: 1..9 selects the nth worker.
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < panes.length) {
				this.#focused = index;
				this.#ui.requestRender();
			}
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#tick) clearInterval(this.#tick);
		this.#tick = undefined;
	}

	render(width: number): readonly string[] {
		const height = Math.max(8, this.#ui.terminal.rows);
		const tile = this.#wide && width >= TILE_MIN_COLUMNS;
		const body = tile ? this.#renderTiles(width, height) : this.#renderFocus(width, height);
		return body;
	}

	/** Header: goal, worker tally, and elapsed run time. */
	#header(width: number): string {
		const total = this.#panes.length;
		const done = this.#panes.filter(pane => pane.state === "completed").length;
		const failed = this.#panes.filter(pane => pane.state === "failed").length;
		const left = ` ${chalk.bold("orchestrate")} ${chalk.dim("·")} ${truncateToWidth(this.#options.goal, Math.max(10, width - 40))}`;
		const tally = [`${done}/${total} done`];
		if (failed > 0) tally.push(chalk.red(`${failed} failed`));
		const right = chalk.dim(tally.join(" · "));
		const pad = Math.max(1, width - Bun.stringWidth(left) - Bun.stringWidth(right) - 1);
		return truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width);
	}

	#footer(width: number): string {
		const hints = this.#wide
			? `${formatKeyHints(["tab", "enter", "l", "q"])} switch · expand · layout · quit`
			: `${formatKeyHint("tab")} switch · ${formatKeyHint("q")} quit`;
		return truncateToWidth(chalk.dim(` ${hints}`), width);
	}

	/** Tile panes side by side, at most `MAX_TILED_PANES` per screen. */
	#renderTiles(width: number, height: number): string[] {
		const visible = this.#panes.slice(0, MAX_TILED_PANES);
		if (visible.length === 0) return [this.#header(width), "", "  waiting for workers…", "", this.#footer(width)];

		const columns = visible.length <= 2 ? visible.length : Math.ceil(Math.sqrt(visible.length));
		const rows = Math.ceil(visible.length / columns);
		const paneWidth = Math.max(20, Math.floor((width - (columns + 1)) / columns));
		const innerHeight = Math.max(4, Math.floor((height - 4) / rows) - 2);

		const lines: string[] = [this.#header(width)];
		for (let row = 0; row < rows; row++) {
			const slice = visible.slice(row * columns, row * columns + columns);
			lines.push(...this.#renderPaneRow(slice, paneWidth, innerHeight, width));
		}
		lines.push(this.#footer(width));
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	/** One row of panes: every pane's lines padded to a common height. */
	#renderPaneRow(panes: readonly WorkerPane[], paneWidth: number, innerHeight: number, width: number): string[] {
		const rendered = panes.map(pane => {
			const index = this.#panes.indexOf(pane);
			return this.#paneBox(pane, paneWidth, innerHeight, index === this.#focused);
		});
		const height = Math.max(...rendered.map(box => box.length), 1);
		const out: string[] = [];
		for (let i = 0; i < height; i++) {
			out.push(truncateToWidth(rendered.map(box => box[i] ?? " ".repeat(paneWidth)).join(" "), width));
		}
		return out;
	}

	/** Single-pane layout for narrow terminals: the focused worker, full width. */
	#renderFocus(width: number, height: number): string[] {
		const pane = this.#panes[this.#focused];
		if (!pane) return [this.#header(width), "", "  waiting for workers…", "", this.#footer(width)];
		const box = this.#paneBox(pane, width, height - 3, true, this.#expanded);
		return [this.#header(width), ...box, this.#footer(width)].slice(0, height);
	}

	/**
	 * Draw one worker as a bordered box: title row, state/task/scope lines, then
	 * the tail of its output. Every line is exactly `paneWidth` columns so a row
	 * of boxes aligns.
	 */
	#paneBox(pane: WorkerPane, paneWidth: number, innerHeight: number, focused: boolean, expanded = false): string[] {
		const border = focused ? chalk.cyan : chalk.dim;
		const inner = Math.max(4, paneWidth - 2);
		const { glyph, paint } = stateMark(pane.state);

		const title = `${glyph} ${pane.label}`;
		const branch = pane.branchName ? ` ${chalk.dim(pane.branchName)}` : "";
		const top = border("┌") + this.#fit(`${paint(title)}${branch}`, inner) + border("┐");

		const rows: string[] = [top];

		const statusBits: string[] = [paint(pane.state)];
		if (pane.elapsedMs !== undefined) statusBits.push(chalk.dim(formatDuration(pane.elapsedMs)));
		if (pane.tokens !== undefined) statusBits.push(chalk.dim(`${compactCount(pane.tokens)} tok`));
		rows.push(border("│") + this.#fit(` ${statusBits.join(chalk.dim(" · "))}`, inner) + border("│"));

		if (pane.taskTitle ?? pane.taskId) {
			rows.push(border("│") + this.#fit(chalk.dim(` ${pane.taskTitle ?? pane.taskId}`), inner) + border("│"));
		}
		if (pane.targetFiles && pane.targetFiles.length > 0) {
			const files =
				pane.targetFiles.length === 1
					? pane.targetFiles[0]
					: `${pane.targetFiles[0]} +${pane.targetFiles.length - 1}`;
			rows.push(border("│") + this.#fit(chalk.dim(` ${files}`), inner) + border("│"));
		}

		if (pane.error) {
			rows.push(border("│") + this.#fit(chalk.red(` ${pane.error}`), inner) + border("│"));
		}

		const outputHeight = Math.max(0, innerHeight - rows.length);
		const limit = expanded ? EXPANDED_LINES : PREVIEW_LINES;
		const tail = (pane.output ?? []).slice(-Math.min(limit, outputHeight));
		for (const line of tail) {
			rows.push(border("│") + this.#fit(chalk.dim(` ${line}`), inner) + border("│"));
		}

		while (rows.length < innerHeight) rows.push(border("│") + " ".repeat(inner) + border("│"));
		rows.push(border("└") + border("─".repeat(inner)) + border("┘"));
		return rows;
	}

	/** Truncate to `width` visible columns, then pad, so boxes line up. */
	#fit(text: string, width: number): string {
		const truncated = truncateToWidth(text, width);
		const pad = width - Bun.stringWidth(truncated);
		return truncated + " ".repeat(Math.max(0, pad));
	}
}

/** Mount the board fullscreen and resolve when the run ends. */
export async function runOrchestratorBoard(
	options: OrchestratorBoardOptions,
	host: OrchestratorBoardHost,
): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new OrchestratorBoardComponent(ui, options, host);
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
