import { describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import { cfgThemeDark } from "@marsai-org/coding-agent/modes/settings";
import type { InteractiveModeContext } from "@marsai-org/coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@marsai-org/coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@marsai-org/tui/theme";

function createHarness() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const settings = Settings.isolated({});
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		settings,
		sessionManager: { getCwd: () => "/tmp/theme-test" },
	} as unknown as InteractiveModeContext;
	return { ctx, settings, setText, showStatus, showError, runtime: { ctx } as BuiltinSlashCommandRuntime };
}

describe("/theme slash command", () => {
	it("persists the chosen theme so it survives the session", async () => {
		resetSettingsForTest();
		await initTheme(false);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/theme set dark-gruvbox", harness.runtime);

		expect(handled).toBe(true);
		// `setTheme` alone only swaps the live instance; the setting is what the
		// next launch reads.
		expect(cfgThemeDark.get(harness.settings)).toBe("dark-gruvbox");
		const text = Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("Theme set to dark-gruvbox");
	});

	it("rejects an unknown theme without changing the stored value", async () => {
		resetSettingsForTest();
		await initTheme(false);
		const harness = createHarness();
		const before = cfgThemeDark.get(harness.settings);

		await executeBuiltinSlashCommand("/theme set definitely-not-a-theme", harness.runtime);

		expect(cfgThemeDark.get(harness.settings)).toBe(before);
	});
});
