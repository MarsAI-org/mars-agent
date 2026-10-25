import { describe, expect, it } from "bun:test";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { CURSOR_MARKER, type TerminalFramePlan, type TerminalFrameProvider, TUI } from "@marsai-org/tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/** Records every write so a dropped frame is observable as an absent write. */
class CountingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** A plan held by the test: mutate `plan` to change what the next frame paints. */
class MutableProvider implements TerminalFrameProvider {
	plan: TerminalFramePlan;
	readonly acknowledged: number[] = [];

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(): TerminalFramePlan {
		return this.plan;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
	}
}

describe("frames that change nothing", () => {
	withoutTerminalMultiplexer();

	it("skips the write when the body rewrites no row and the cursor is already parked", async () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new MutableProvider({ viewport: ["alpha", "editor"] });
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();

		await scheduler.settle(terminal);
		const afterFirstFrame = terminal.writes.length;
		expect(afterFirstFrame).toBeGreaterThan(0);

		// A stream of ordinary requests with no changed row must write nothing.
		// Terminals honoring DEC 2026 recomposite per synchronized frame, so these
		// empty frames are what read as a display that never settles.
		for (let frame = 0; frame < 40; frame++) tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.length).toBe(afterFirstFrame);

		// A changed row still paints.
		provider.plan = { viewport: ["alpha", "editor changed"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.length).toBeGreaterThan(afterFirstFrame);
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.filter(Boolean),
		).toEqual(["alpha", "editor changed"]);
		tui.stop();
	});

	it("acknowledges an offered history batch even when the frame itself is dropped", async () => {
		const terminal = new CountingTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		let offered = true;
		const acknowledged: number[] = [];
		const provider: TerminalFrameProvider = {
			renderFrame() {
				const plan: TerminalFramePlan = offered
					? { history: { id: 1, rows: ["retired row"] }, viewport: ["editor"] }
					: { viewport: ["editor"] };
				offered = false;
				return plan;
			},
			acknowledgeHistory(id: number) {
				acknowledged.push(id);
			},
		};
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();

		await scheduler.settle(terminal);
		for (let frame = 0; frame < 10; frame++) tui.requestRender();
		await scheduler.settle(terminal);

		// Exactly one acknowledgement: a dropped frame that skipped the ack would
		// leave the provider free to re-offer the same rows.
		expect(acknowledged).toEqual([1]);
		// And the retired row is in scrollback exactly once.
		const rows = terminal.getViewport().map(row => row.trimEnd());
		expect(rows.filter(row => row === "retired row")).toHaveLength(1);
		tui.stop();
	});

	it("still writes when the cursor marker moves", async () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new MutableProvider({ viewport: [`alpha${CURSOR_MARKER}`, "editor"] });
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();

		await scheduler.settle(terminal);
		const baseline = terminal.writes.length;

		// Same rows, marker one column over: the cursor paint must reach the screen.
		provider.plan = { viewport: [`alph${CURSOR_MARKER}a`, "editor"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.length).toBeGreaterThan(baseline);
		expect(terminal.getCursor().col).toBe(4);
		tui.stop();
	});

	it("writes when a forced repaint is requested", async () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new MutableProvider({ viewport: ["alpha", "editor"] });
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();

		await scheduler.settle(terminal);
		const baseline = terminal.writes.length;
		tui.requestRender(true);
		await scheduler.settle(terminal);
		expect(terminal.writes.length).toBeGreaterThan(baseline);
		tui.stop();
	});
});
