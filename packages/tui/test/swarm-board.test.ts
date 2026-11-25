/**
 * Live Swarm Board TUI overlay tests.
 *
 * Exercises rendering across dark/light themes, wide/narrow layouts, strict
 * width sanitization, `@mention` and `[done]` highlighting, pane focus cycling,
 * scroll behavior, and kill/stop/detach callbacks.
 */

import * as os from "node:os";
import { describe, expect, test } from "bun:test";
import {
	type SwarmBoardCallbacks,
	SwarmBoardComponent,
	type SwarmBoardMemberSnapshot,
	type SwarmBoardMessageSnapshot,
	type SwarmBoardSnapshot,
} from "@marsai-org/tui/apps/swarm-board";
import { initTheme, setSymbolPreset, setTheme, theme } from "@marsai-org/tui/theme";

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

function makeSnapshot(overrides?: Partial<SwarmBoardSnapshot>): SwarmBoardSnapshot {
	const members: readonly SwarmBoardMemberSnapshot[] = [
		{
			name: "coordinator",
			role: "coordinator",
			state: "waiting",
			model: "anthropic/claude-opus-4-6",
			workspace: "inherit",
			lastPostSeq: 2,
			outputTail: ["Dispatched parser and verifier."],
			tokens: 4200,
		},
		{
			name: "parser",
			role: "worker",
			state: "working",
			model: "anthropic/claude-sonnet-4-5",
			workspace: "worktree",
			currentActivity: "Editing src/parser.ts",
			lastPostSeq: 3,
			outputTail: ["Reading grammar rules...", "Running bun test parser.test.ts"],
			tokens: 18_450,
		},
		{
			name: "verifier",
			role: "worker",
			state: "killed",
			model: "openai/gpt-5.2",
			workspace: "inherit",
			outputTail: ["All 14 checks passed."],
		},
	];
	const messages: readonly SwarmBoardMessageSnapshot[] = [
		{
			seq: 1,
			agent: "coordinator",
			text: "@parser implement the lexer and hand off to @verifier.",
			time: "07:35:01",
			mentions: ["parser", "verifier"],
		},
		{
			seq: 2,
			agent: "parser",
			text: "@coordinator [done] Lexer landed with 14 passing tests.",
			time: "07:36:12",
			mentions: ["coordinator"],
		},
	];
	return {
		swarmId: "swarm-42",
		title: "Implement Lexer & Verifier",
		members,
		messages,
		...overrides,
	};
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

describe("swarm board", () => {
	test("renders wide side-by-side roster, board, and output panes and stacks cleanly on narrow widths", () => {
		const ui = fakeUi(32);
		const board = new SwarmBoardComponent(
			ui as never,
			{
				snapshot: () => makeSnapshot(),
				detach: () => {},
			},
			{ tickMs: 60_000 },
		);
		void board.run();

		try {
			const wideLines = plain(board.render(120));
			const wideFrame = wideLines.join("\n");
			expect(wideFrame).toContain("Implement Lexer & Verifier");
			expect(wideFrame).toContain("2 workers");
			expect(wideFrame).toContain("1 working");
			expect(wideFrame).toContain("1 waiting");
			expect(wideFrame).toContain("#2 posts");
			expect(wideFrame).toContain("Roster");
			expect(wideFrame).toContain("Board");
			expect(wideFrame).toContain("Output · coordinator");
			// Wide layout puts Roster and Board headers on the same row.
			const headerRow = wideLines.find(line => line.includes("Roster") && line.includes("Board"));
			expect(headerRow).toBeDefined();

			const narrowLines = plain(board.render(70));
			const narrowFrame = narrowLines.join("\n");
			expect(narrowFrame).toContain("Roster");
			expect(narrowFrame).toContain("Board");
			expect(narrowFrame).toContain("Output");
			// Narrow layout stacks Roster above Board rather than side by side.
			const stackedRow = narrowLines.find(line => line.includes("Roster") && line.includes("Board"));
			expect(stackedRow).toBeUndefined();
		} finally {
			board.dispose();
		}
	});

	test("every rendered line fits within width and sanitizes tabs, control chars, and home paths across 60/90/120/160", () => {
		const home = os.homedir();
		const ui = fakeUi(34);
		const snapshot = makeSnapshot({
			title: `Build\t${home}/secret-project\x07`,
			members: [
				{
					name: "worker\t1\x07",
					role: "worker",
					state: "working",
					model: "provider/very-long-model-identifier-for-width-safety",
					workspace: "worktree",
					currentActivity: `bash\tcat ${home}/private.txt\x00`,
					lastPostSeq: 1,
					outputTail: [`line\twith\ttabs and ${home}/repo/src/index.ts\x07`, "x".repeat(220)],
					tokens: 99_999,
				},
			],
			messages: [
				{
					seq: 1,
					agent: "coordinator",
					text: `@worker-1 [done] inspect\t${home}/repo/file.ts\x00 and ${"longtoken".repeat(20)}`,
					time: "07:40:00",
					mentions: ["worker-1"],
				},
			],
		});
		const board = new SwarmBoardComponent(
			ui as never,
			{ snapshot: () => snapshot, detach: () => {} },
			{ tickMs: 60_000 },
		);
		void board.run();

		try {
			for (const width of [60, 90, 120, 160]) {
				const rendered = board.render(width);
				for (const line of rendered) {
					const stripped = Bun.stripANSI(line);
					expect(Bun.stringWidth(stripped)).toBeLessThanOrEqual(width);
					expect(stripped).not.toContain("\t");
					expect(stripped).not.toContain("\x07");
					expect(stripped).not.toContain("\x00");
					expect(stripped).not.toContain(home);
				}
			}
		} finally {
			board.dispose();
		}
	});

	test("highlights @mentions with accent and [done] with success across dark and light Mars themes", async () => {
		await initTheme(false);
		const ui = fakeUi(30);
		const board = new SwarmBoardComponent(
			ui as never,
			{ snapshot: () => makeSnapshot(), detach: () => {} },
			{ tickMs: 60_000 },
		);
		void board.run();

		try {
			await setTheme("dark");
			const darkFrame = board.render(120).join("\n");
			expect(darkFrame).toContain(theme.bold(theme.fg("accent", "@parser")));
			expect(darkFrame).toContain(theme.bold(theme.fg("success", "[done]")));
			expect(darkFrame).toContain(theme.getFgAnsi("borderAccent"));
			expect(darkFrame).toContain(theme.getFgAnsi("borderMuted"));
			expect(darkFrame).toContain(theme.getBgAnsi("selectedBg"));

			await setTheme("light");
			const lightFrame = board.render(120).join("\n");
			expect(lightFrame).toContain(theme.bold(theme.fg("accent", "@parser")));
			expect(lightFrame).toContain(theme.bold(theme.fg("success", "[done]")));
			expect(lightFrame).toContain(theme.getFgAnsi("borderAccent"));
			expect(lightFrame).toContain(theme.getFgAnsi("borderMuted"));
			expect(lightFrame).not.toBe(darkFrame);
		} finally {
			await setTheme("dark");
			board.dispose();
		}
	});

	test("handles focus switching, roster navigation, board scrolling, killWorker, stopAll, and detach", async () => {
		const killed: string[] = [];
		let detached = 0;
		let stopped = 0;

		const longMessages: SwarmBoardMessageSnapshot[] = Array.from({ length: 24 }, (_, idx) => ({
			seq: idx + 1,
			agent: idx % 2 === 0 ? "coordinator" : "parser",
			text: `Message number ${idx + 1} for scroll testing.`,
			time: "07:41:00",
			mentions: [],
		}));

		const ui = fakeUi(24);
		const callbacks: SwarmBoardCallbacks = {
			snapshot: () => makeSnapshot({ messages: longMessages }),
			killWorker: name => {
				killed.push(name);
			},
			stopAll: () => {
				stopped++;
			},
			detach: () => {
				detached++;
			},
		};
		const board = new SwarmBoardComponent(ui as never, callbacks, { tickMs: 60_000 });
		const donePromise = board.run();

		// Initial focus is Roster on member 0 (coordinator); k must NOT kill coordinator.
		expect(plain(board.render(120)).join("\n")).toContain("Output · coordinator");
		board.handleInput("k");
		expect(killed).toEqual([]);

		// Move selection down to worker "parser" (worktree) and verify output pane updates + k kills it.
		board.handleInput("\x1b[B"); // Down arrow
		const parserFrame = plain(board.render(120)).join("\n");
		expect(parserFrame).toContain("Output · parser");
		expect(parserFrame).toContain("Editing src/parser.ts");
		expect(parserFrame).toContain("wt");
		board.handleInput("k");
		expect(killed).toEqual(["parser"]);

		// Tab to Board focus: initially auto-scrolled to newest (#24); PageUp scrolls to older messages.
		board.handleInput("\t");
		const bottomBoard = plain(board.render(120)).join("\n");
		expect(bottomBoard).toContain("#24");
		board.handleInput("\x1b[5~"); // PageUp
		board.handleInput("\x1b[5~");
		board.handleInput("\x1b[5~");
		const scrolledBoard = plain(board.render(120)).join("\n");
		expect(scrolledBoard).toContain("scrolled");

		// Tab to Output focus, then Shift+Tab back to Board, then q detaches cleanly without stopAll.
		board.handleInput("\t");
		expect(plain(board.render(120)).join("\n")).toContain("focus (output)");
		// Uppercase K kills the selected worker even when Output (non-roster) is focused; lowercase k scrolls up.
		board.handleInput("K");
		expect(killed).toEqual(["parser", "parser"]);
		board.handleInput("\x1b[Z"); // Shift+Tab
		expect(plain(board.render(120)).join("\n")).toContain("focus (board)");

		board.handleInput("q");
		await donePromise;
		expect(detached).toBe(1);
		expect(stopped).toBe(0);

		// Verify Escape also detaches and Ctrl+X invokes stopAll.
		const board2 = new SwarmBoardComponent(ui as never, callbacks, { tickMs: 60_000 });
		const done2 = board2.run();
		board2.handleInput("\x1b");
		await done2;
		expect(detached).toBe(2);
		expect(stopped).toBe(0);

		const board3 = new SwarmBoardComponent(ui as never, callbacks, { tickMs: 60_000 });
		const done3 = board3.run();
		board3.handleInput("\x18"); // Ctrl+X
		await done3;
		expect(stopped).toBe(1);
	});

	test("handles empty board and tiny terminal widths without overflowing", () => {
		const ui = fakeUi(14);
		const board = new SwarmBoardComponent(
			ui as never,
			{
				snapshot: () => ({ swarmId: "s-empty", title: "", members: [], messages: [] }),
				detach: () => {},
			},
			{ tickMs: 60_000 },
		);
		void board.run();
		try {
			const normal = plain(board.render(80)).join("\n");
			expect(normal).toContain("No members yet");
			expect(normal).toContain("Board is empty");
			expect(normal).toContain("No member selected");

			for (const line of board.render(8)) {
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(8);
			}

			// Small terminal height (below 12 rows) clamps cleanly without throwing.
			const smallUi = fakeUi(8);
			const smallBoard = new SwarmBoardComponent(
				smallUi as never,
				{ snapshot: () => makeSnapshot(), detach: () => {} },
				{ tickMs: 60_000 },
			);
			void smallBoard.run();
			try {
				expect(smallBoard.render(60).length).toBe(12);
			} finally {
				smallBoard.dispose();
			}
		} finally {
			board.dispose();
		}
	});

	test("supports LayoutDensity compact mode and ascii symbol preset", async () => {
		await initTheme(false);
		const ui = fakeUi(30);
		const board = new SwarmBoardComponent(
			ui as never,
			{ snapshot: () => makeSnapshot(), detach: () => {} },
			{ tickMs: 60_000, density: "compact" },
		);
		void board.run();
		try {
			// Compact mode renders single-line roster rows (omitting the separate meta line) and omits inter-message blank lines.
			const compactFrame = plain(board.render(120)).join("\n");
			expect(compactFrame).not.toContain("working · claude-sonnet-4-5");
			expect(compactFrame).toContain("parser");

			await setSymbolPreset("ascii");
			const asciiFrame = plain(board.render(120)).join("\n");
			expect(asciiFrame).toContain(">");
			expect(asciiFrame).not.toMatch(/[❯○■×⚙]/);
		} finally {
			await setSymbolPreset("unicode");
			board.dispose();
		}
	});

	test("windows large rosters and scrolls large message boards cleanly", () => {
		const members: SwarmBoardMemberSnapshot[] = Array.from({ length: 30 }, (_, idx) => ({
			name: `worker-${idx + 1}`,
			role: idx === 0 ? "coordinator" : "worker",
			state: idx % 2 === 0 ? "working" : "waiting",
			model: "anthropic/claude-sonnet-4-5",
			workspace: "inherit",
			outputTail: [`output ${idx + 1}`],
		}));
		const messages: SwarmBoardMessageSnapshot[] = Array.from({ length: 120 }, (_, idx) => ({
			seq: idx + 1,
			agent: "coordinator",
			text: `Post ${idx + 1}`,
			time: "08:00:00",
			mentions: [],
		}));
		const ui = fakeUi(24);
		const board = new SwarmBoardComponent(
			ui as never,
			{ snapshot: () => makeSnapshot({ members, messages }), detach: () => {} },
			{ tickMs: 60_000 },
		);
		void board.run();
		try {
			// Jump to end of 30-member roster
			board.handleInput("\x1b[F"); // End
			const frame = plain(board.render(120)).join("\n");
			expect(frame).toContain("Output · worker-30");
			expect(frame).toContain("#120");
		} finally {
			board.dispose();
		}
	});
});
