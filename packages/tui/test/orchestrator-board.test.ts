/**
 * Orchestrator board rendering.
 *
 * The board is a pure function of its snapshot, so these tests drive it with a
 * fake TUI and assert on the lines it produces: pane count, alignment, the
 * narrow fallback, and key navigation.
 */

import * as os from "node:os";
import { describe, expect, test } from "bun:test";
import {
	OrchestratorBoardComponent,
	type OrchestratorBoardHost,
	SwarmBoardComponent,
	type WorkerPane,
} from "@marsai-org/tui/apps/orchestrator-board";

/** Minimal TUI stand-in: the board only calls requestRender and reads terminal.rows. */
function fakeUi(rows: number) {
	let renders = 0;
	return {
		terminal: { rows },
		requestRender: () => {
			renders++;
		},
		renders: () => renders,
	};
}

function pane(overrides: Partial<WorkerPane> & { workerId: string }): WorkerPane {
	return {
		label: overrides.workerId,
		state: "running",
		...overrides,
	};
}

function host(panes: readonly WorkerPane[], onStop = () => {}): OrchestratorBoardHost {
	return { snapshot: () => panes, stopAll: onStop };
}

/** Strip ANSI so assertions read the glyphs, not the colour codes. */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

describe("orchestrator board", () => {
	test("tiles several workers side by side on a wide terminal", async () => {
		const ui = fakeUi(30);
		const panes = [pane({ workerId: "w1", label: "frontend" }), pane({ workerId: "w2", label: "backend" })];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "ship the thing" }, host(panes));
		void board.run();

		const lines = plain(board.render(120));

		// Both pane titles appear on the same row, which is what "tiled" means.
		const titleRow = lines.find(line => line.includes("frontend"));
		expect(titleRow).toBeDefined();
		expect(titleRow).toContain("backend");
		board.dispose();
	});

	test("shows one worker at a time on a narrow terminal", async () => {
		const ui = fakeUi(24);
		const panes = [pane({ workerId: "w1", label: "frontend" }), pane({ workerId: "w2", label: "backend" })];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "narrow" }, host(panes));
		void board.run();

		const lines = plain(board.render(60));
		const frame = lines.join("\n");

		expect(frame).toContain("frontend");
		// The unfocused pane is not drawn at all in the narrow layout.
		expect(frame).not.toContain("backend");
		board.dispose();
	});

	test("every rendered row fits the terminal width", async () => {
		const ui = fakeUi(40);
		const panes = [
			pane({ workerId: "w1", label: "a-very-long-worker-name-indeed" }),
			pane({ workerId: "w2", label: "b" }),
			pane({ workerId: "w3", label: "c" }),
		];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "width" }, host(panes));
		void board.run();

		for (const width of [8, 16, 24, 40, 80, 120, 200]) {
			for (const line of board.render(width)) {
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
			}
		}
		board.dispose();
	});

	test("tab moves the focus and the narrow layout follows it", async () => {
		const ui = fakeUi(24);
		const panes = [pane({ workerId: "w1", label: "first" }), pane({ workerId: "w2", label: "second" })];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "focus", narrow: true }, host(panes));
		void board.run();

		expect(plain(board.render(60)).join("\n")).toContain("first");
		board.handleInput("\t");
		expect(plain(board.render(60)).join("\n")).toContain("second");
		board.dispose();
	});

	test("a digit jumps straight to that worker", async () => {
		const ui = fakeUi(24);
		const panes = [
			pane({ workerId: "w1", label: "one" }),
			pane({ workerId: "w2", label: "two" }),
			pane({ workerId: "w3", label: "three" }),
		];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "jump", narrow: true }, host(panes));
		void board.run();

		board.handleInput("3");
		expect(plain(board.render(60)).join("\n")).toContain("three");
		board.dispose();
	});

	test("a completed worker shows its check mark and a failed one its cross", async () => {
		const ui = fakeUi(24);
		const panes = [
			pane({ workerId: "w1", label: "ok", state: "completed" }),
			pane({ workerId: "w2", label: "bad", state: "failed", error: "conflict in src/a.ts" }),
		];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "states", narrow: true }, host(panes));
		void board.run();

		const first = plain(board.render(80)).join("\n");
		expect(first).toContain("✔");

		board.handleInput("\t");
		const second = plain(board.render(80)).join("\n");
		expect(second).toContain("✘");
		// The failure reason is on the pane, not only in a log elsewhere.
		expect(second).toContain("conflict in src/a.ts");
		board.dispose();
	});

	test("shows the isolation branch once a worker has one", async () => {
		const ui = fakeUi(24);
		const panes = [pane({ workerId: "w1", label: "iso", branchName: "mars-task-a1b2" })];
		const board = new OrchestratorBoardComponent(ui as never, { goal: "branch" }, host(panes));
		void board.run();

		expect(plain(board.render(80)).join("\n")).toContain("mars-task-a1b2");
		board.dispose();
	});

	test("q stops the whole run", async () => {
		let stopped = false;
		const ui = fakeUi(24);
		const board = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "quit" },
			host([pane({ workerId: "w1" })], () => {
				stopped = true;
			}),
		);
		void board.run();

		board.handleInput("q");

		expect(stopped).toBe(true);
	});

	test("renders a waiting state before any worker exists", async () => {
		const ui = fakeUi(24);
		const board = new OrchestratorBoardComponent(ui as never, { goal: "empty" }, host([]));
		void board.run();

		expect(plain(board.render(80)).join("\n")).toContain("waiting for workers");
		board.dispose();
	});

	test("keeps the focus on the same worker when the snapshot reorders", async () => {
		const ui = fakeUi(24);
		let panes: WorkerPane[] = [pane({ workerId: "w1", label: "alpha" }), pane({ workerId: "w2", label: "beta" })];
		const board = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "stable", narrow: true },
			{ snapshot: () => panes, stopAll: () => {} },
		);
		void board.run();

		board.handleInput("\t"); // focus beta
		expect(plain(board.render(60)).join("\n")).toContain("beta");

		// Reorder: the same worker is now first, and refresh() pulls the new snapshot.
		panes = [pane({ workerId: "w2", label: "beta" }), pane({ workerId: "w1", label: "alpha" })];
		board.refresh();

		expect(plain(board.render(60)).join("\n")).toContain("beta");
		expect(plain(board.render(60)).join("\n")).not.toContain("alpha");
		board.dispose();
	});

	test("c cancels the focused worker and footer advertises cancel hint", async () => {
		const cancelled: string[] = [];
		const ui = fakeUi(24);
		const panes = [pane({ workerId: "w1", label: "alpha" }), pane({ workerId: "w2", label: "beta" })];
		const board = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "cancel-worker", narrow: true },
			{
				snapshot: () => panes,
				stopAll: () => {},
				cancelWorker: id => {
					cancelled.push(id);
				},
			},
		);
		void board.run();

		expect(plain(board.render(80)).join("\n")).toContain("cancel");
		board.handleInput("\t"); // move focus to w2
		board.handleInput("c");

		expect(cancelled).toEqual(["w2"]);
		board.dispose();
	});

	test("q and escape detach without stopping when detach is provided, while X stops all", async () => {
		let detached = 0;
		let stopped = 0;
		const ui = fakeUi(24);
		const board1 = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "detach-q" },
			{
				snapshot: () => [pane({ workerId: "w1" })],
				stopAll: () => {
					stopped++;
				},
				detach: () => {
					detached++;
				},
			},
		);
		const run1 = board1.run();
		expect(plain(board1.render(100)).join("\n")).toContain("detach");
		board1.handleInput("q");
		await run1;
		expect(detached).toBe(1);
		expect(stopped).toBe(0);

		const board2 = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "detach-esc" },
			{
				snapshot: () => [pane({ workerId: "w1" })],
				stopAll: () => {
					stopped++;
				},
				detach: () => {
					detached++;
				},
			},
		);
		const run2 = board2.run();
		board2.handleInput("\x1b");
		await run2;
		expect(detached).toBe(2);
		expect(stopped).toBe(0);

		const board3 = new OrchestratorBoardComponent(
			ui as never,
			{ goal: "stop-X" },
			{
				snapshot: () => [pane({ workerId: "w1" })],
				stopAll: () => {
					stopped++;
				},
				detach: () => {
					detached++;
				},
			},
		);
		const run3 = board3.run();
		board3.handleInput("X");
		await run3;
		expect(detached).toBe(2);
		expect(stopped).toBe(1);
	});

	test("renders currentTool, retry attempts, swarm branding, and sanitizes tabs/control chars/home paths", async () => {
		expect(SwarmBoardComponent).toBe(OrchestratorBoardComponent);
		const home = os.homedir();
		const ui = fakeUi(28);
		const panes = [
			pane({
				workerId: "w1",
				label: "front\tend\x07",
				state: "running",
				attempts: 2,
				branchName: "swarm/w1\tbranch",
				taskTitle: "Fix\tlayout\x1b[31m!",
				targetFiles: [`${home}/project/src/app.ts`, `${home}/project/src/other.ts`],
				currentTool: "edit\tsrc/app.ts",
				error: "minor\twarning\x07",
				output: [`line\tone\t${home}/secret.ts`, "line\ttwo\x00"],
			}),
		];
		const board = new OrchestratorBoardComponent(
			ui as never,
			{ goal: `ship\t${home}/app\x07`, narrow: true },
			host(panes),
		);
		void board.run();

		const rendered = plain(board.render(90));
		const frame = rendered.join("\n");

		expect(frame).toContain("swarm");
		expect(frame).toContain("↻2");
		expect(frame).toContain("⚙ edit");
		expect(frame).toContain("~/project/src/app.ts +1");
		expect(frame).not.toContain("\t");
		expect(frame).not.toContain("\x07");
		expect(frame).not.toContain("\x00");
		expect(frame).not.toContain(home);
		board.dispose();
	});
});
