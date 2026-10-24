import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	disposeTerminalTitleState,
	initTerminalTitleState,
	popTerminalTitle,
	setSessionTerminalTitle,
	setTerminalTitleEnabled,
	setTerminalTitleState,
} from "@marsai-org/coding-agent/utils/title-generator";
import { Settings } from "@marsai-org/coding-agent/config/settings";
import { cfgTuiTitle } from "@marsai-org/coding-agent/modes/settings";
import { setTerminalHeadless } from "@marsai-org/utils";
import { mockWindowsConsoleTitle, type WindowsConsoleTitleMock } from "./terminal-title-test-utils";

/**
 * `tui.title: false` promises the tab/window keeps the title the shell gave it.
 * The contract is pinned at the observable sink — the OSC 0 sequence on
 * `process.stdout.write` — because a user sees the interference there, not in
 * the runtime flags that compose it.
 */
describe("tui.title", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;
	const wslEnvKeys = ["WSL_DISTRO_NAME", "WSL_INTEROP"] as const;
	let savedWslEnv: Record<string, string | undefined> = {};

	/** Titles observed through either sink (OSC writes plus the native title mock). */
	const observedTitles = (): string[] => [
		...writes.map(payload => /\x1b\]0;([\s\S]*?)\x07/.exec(payload)?.[1]).filter((t): t is string => t !== undefined),
		...(windowsTitleMock?.titles ?? []),
	];

	beforeEach(() => {
		vi.useFakeTimers();
		savedWslEnv = Object.fromEntries(wslEnvKeys.map(key => [key, Bun.env[key]]));
		for (const key of wslEnvKeys) delete Bun.env[key];

		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		windowsTitleMock = mockWindowsConsoleTitle();
		windowsTitleMock.succeeds = true;
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		initTerminalTitleState();
		setSessionTerminalTitle("my-project");
		setTerminalTitleState("idle");
		writes.length = 0;
		windowsTitleMock.titles.length = 0;
	});

	afterEach(() => {
		// Re-enable before disposing so a disabled runtime never leaks into the next file.
		setTerminalTitleEnabled(true);
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy = undefined;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		vi.useRealTimers();
		for (const key of wslEnvKeys) {
			const value = savedWslEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("defaults to letting mars own the title", () => {
		expect(cfgTuiTitle.get(Settings.isolated())).toBe(true);
	});

	it("writes no OSC title for a run-state change while disabled, and one after re-enabling", () => {
		// Control: enabled (the default), a state change reaches the terminal.
		setTerminalTitleState("working");
		expect(observedTitles().length).toBeGreaterThan(0);

		writes.length = 0;
		windowsTitleMock!.titles.length = 0;
		setTerminalTitleEnabled(false);

		// The disabled runtime must forget the title it last wrote, so re-enabling
		// repaints instead of considering the new title already on screen.
		setTerminalTitleState("attention");
		expect(observedTitles()).toEqual([]);

		// Spinner ticks are silenced too: 80ms frames would otherwise keep rewriting
		// the parent shell's tab while the setting is off.
		setTerminalTitleState("working");
		vi.advanceTimersByTime(400);
		expect(observedTitles()).toEqual([]);

		// Re-enabling repaints the current composed title at once.
		setTerminalTitleEnabled(true);
		expect(observedTitles().length).toBe(1);
		expect(observedTitles()[0]).toContain("my-project");
	});

	it("still restores the shell title at teardown while disabled", () => {
		// The setting silences mars's own titles; it must not silence the xterm
		// window-op that hands the tab back to the shell on exit. Gating that behind
		// the setting would strand the parent shell's tab reading `mars …`.
		setTerminalTitleEnabled(false);
		disposeTerminalTitleState();

		writes.length = 0;
		windowsTitleMock!.titles.length = 0;
		popTerminalTitle();
		expect(writes).toEqual(["\x1b[23;2t"]);

		// And a late run-state change stays silent: teardown owns the terminal again.
		writes.length = 0;
		setTerminalTitleState("working");
		expect(observedTitles()).toEqual([]);
	});
});
