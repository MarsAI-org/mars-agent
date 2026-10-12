import { describe, expect, it } from "bun:test";
import { Terminal as VirtualTerminal } from "@marsai-org/utils/vterm";

const COLUMNS = 120;
const ROWS = 30;
const COMPOSER_BOUNDARY = "╰─";

function terminalLines(terminal: VirtualTerminal): (string | undefined)[] {
	const buffer = terminal.buffer.active;
	return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true).trimEnd());
}

describe.skipIf(process.platform === "win32")("fatal stderr terminal handoff", () => {
	it("keeps the composer boundary intact in a real PTY", async () => {
		const screen = new VirtualTerminal({ cols: COLUMNS, rows: ROWS, scrollback: 100 });
		const closed = Promise.withResolvers<void>();
		const composerSeen = Promise.withResolvers<void>();
		// Row of the composer boundary as it was actually painted, captured before the
		// fatal write. Re-scanning for it after the fact cannot work: the postmortem code
		// frame quotes the fixture's own source line (`input.prompt = "╰─ "`), which lands on
		// that row. Matching it post-hoc would also make the assertion vacuous, because the
		// code frame carries the glyph whether or not the composer ever painted.
		let paintedComposerRow: number | undefined;
		let screenWritten = Promise.resolve();
		await using terminal = new Bun.Terminal({
			cols: COLUMNS,
			rows: ROWS,
			data(_terminal, data) {
				const written = Promise.withResolvers<void>();
				screenWritten = written.promise;
				screen.write(data, () => {
					const rows = terminalLines(screen);
					const row = rows.indexOf(COMPOSER_BOUNDARY);
					if (row >= 0) {
						paintedComposerRow = row;
						composerSeen.resolve();
					}
					written.resolve();
				});
			},
			exit() {
				closed.resolve();
			},
		});
		try {
			const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/fatal-tui.ts`], {
				cwd: process.cwd(),
				// This is a real-terminal contract test: shed the test-runtime markers so
				// the fixture's ProcessTerminal paints instead of going headless
				// (ci-test-ts children inherit PI_TEST_RUNTIME=1).
				env: {
					...process.env,
					MARS_TUI_DEBUG: undefined,
					PI_TEST_RUNTIME: undefined,
					BUN_ENV: undefined,
					NODE_ENV: undefined,
					// Bun's PTY and the VT parser do not implement native TSP surfaces.
					// A parent running in Tern must not turn the fixture's rows into APC JSON.
					TERM: "xterm-256color",
					TERM_PROGRAM: undefined,
					MARS_TUI_NATIVE: "0",
					PI_TUI_NATIVE: "0",
				},
				terminal,
			});

			try {
				// Wait for a painted composer row, not merely matching bytes inside an
				// escape payload; a fixed delay also races the first paint on slow CI.
				await Promise.race([
					composerSeen.promise,
					proc.exited.then(code => {
						throw new Error(`Fatal PTY fixture exited before painting the composer (exit ${code})`);
					}),
				]);
				terminal.write("\r");

				const exitCode = await proc.exited;
				terminal.close();
				await closed.promise;
				await screenWritten;
				expect(exitCode).toBe(1);

				const lines = terminalLines(screen);
				const errorRow = lines.findIndex(line => line?.includes("error: fatal PTY fixture") === true);

				// Assert against the row captured while painting, not a post-hoc scan: after the
				// fatal write the composer row holds the postmortem code frame instead.
				expect(paintedComposerRow ?? -1).toBeGreaterThanOrEqual(0);
				expect(errorRow).toBeGreaterThan(paintedComposerRow ?? -1);
			} finally {
				if (proc.exitCode === null) proc.kill();
				await proc.exited;
			}
		} finally {
			terminal.close();
			await closed.promise;
			await screenWritten;
			screen.dispose();
		}
	}, 30_000);
});
