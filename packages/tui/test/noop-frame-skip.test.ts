import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@marsai-org/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// An ordinary render that rewrites no row and leaves the cursor where it already
// is must not reach the terminal. Terminals honoring DEC 2026 recomposite the
// screen for every synchronized-output frame, so a stream of empty frames reads
// as a permanent refresh while nothing changes (working spinners repaint faster
// than their glyph advances, and idle surfaces repaint on unrelated timers).

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	/** Bytes written since the previous drain. */
	drain(): string {
		const out = this.writes.join("");
		this.writes.length = 0;
		return out;
	}
}

class Rows implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

async function paintInitial(lines: string[]) {
	const terminal = new RecordingTerminal(40, 6);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	const view = new Rows(lines);
	tui.addChild(view);
	tui.start();
	await scheduler.settle(terminal);
	terminal.drain();
	return { terminal, scheduler, tui, view };
}

describe("no-op frame suppression", () => {
	it("skips a render request that changes no row", async () => {
		const { terminal, scheduler, tui } = await paintInitial(["alpha", "beta"]);

		tui.requestRender();
		await scheduler.settle(terminal);

		expect(terminal.drain()).toBe("");
		tui.stop();
	});

	it("still paints the row that did change", async () => {
		const { terminal, scheduler, tui, view } = await paintInitial(["alpha", "beta"]);

		view.lines = ["alpha", "gamma"];
		tui.requestRender();
		await scheduler.settle(terminal);

		expect(terminal.drain()).toContain("gamma");
		expect(terminal.getViewport()).toContain("gamma");
		tui.stop();
	});

	it("resumes painting after a skipped frame", async () => {
		const { terminal, scheduler, tui, view } = await paintInitial(["alpha"]);

		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.drain()).toBe("");

		view.lines = ["delta"];
		tui.requestRender();
		await scheduler.settle(terminal);

		expect(terminal.getViewport().join(" ")).toContain("delta");
		tui.stop();
	});

	it("paints once the viewport shrinks and the cursor parking row moves", async () => {
		const { terminal, scheduler, tui, view } = await paintInitial(["alpha", "beta"]);

		view.lines = ["alpha"];
		tui.requestRender();
		await scheduler.settle(terminal);

		expect(terminal.drain()).not.toBe("");
		tui.stop();
	});
});
