import { describe, expect, it, type Mock, vi } from "bun:test";
import { AssistantMessageComponent } from "@marsai-org/tui/chat/assistant-message";
import { Settings } from "@marsai-org/coding-agent/config/settings";
import { InputController } from "@marsai-org/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@marsai-org/coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@marsai-org/coding-agent/session/settings";

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	assistant.setExpanded = vi.fn();
	return assistant;
}

/**
 * Fixture for the Ctrl+O expansion gesture: the assistant row is the only
 * thinking-carrying child, and the container methods the gesture repaints
 * through are spies so the test can tell a rebuild from a no-op.
 */
function createContext(options: {
	settings: Settings;
	hideThinkingBlock: boolean;
	assistant: AssistantMessageComponent;
}) {
	const resetDisplay = vi.fn();
	const resetStableEmission = vi.fn();
	return {
		hideToolActivity: false,
		toolOutputExpanded: false,
		thinkingExpanded: undefined,
		hideThinkingBlock: options.hideThinkingBlock,
		settings: options.settings,
		session: { agent: { hideThinkingSummary: false }, thinkingLevel: "high" },
		chatContainer: {
			children: [options.assistant],
			resetStableEmission,
		},
		streamingComponent: undefined,
		streamingMessage: undefined,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn(), resetDisplay },
	} as unknown as InteractiveModeContext;
}

describe("InputController thinking expansion via ctrl+o", () => {
	it("hides thinking blocks by default", () => {
		// Fresh installs are quiet: thinking stays out of the transcript until the
		// transcript is expanded, so the persisted default must be `true`.
		const settings = Settings.isolated();
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
	});

	it("reveals thinking when expanding and keeps the preference unwritten", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const ctx = createContext({ settings, hideThinkingBlock: true, assistant });
		const controller = new InputController(ctx);

		controller.toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(false);
		expect(ctx.chatContainer.resetStableEmission).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
		// The reveal is a display gesture: the persisted preference is untouched, so
		// nothing is written to the settings file and Ctrl+T keeps its meaning.
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
	});

	it("hides thinking again when collapsing, leaving an explicit ctrl+t preference intact", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		// The user explicitly asked for visible thinking with Ctrl+T.
		cfgHideThinkingBlock.set(settings, false);
		const ctx = createContext({ settings, hideThinkingBlock: false, assistant });
		const controller = new InputController(ctx);

		controller.toggleToolOutputExpansion();
		// The preference already renders thinking, so expanding repaints nothing.
		expect(setHideThinkingBlock).not.toHaveBeenCalled();

		controller.toggleToolOutputExpansion();

		// Collapsing hides thinking even though the preference shows it — a
		// collapsed transcript is what the gesture asked for.
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		// ...and the preference it borrowed from is untouched, so the user's
		// explicit Ctrl+T choice survives the whole expand/collapse cycle.
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(ctx.hideThinkingBlock).toBe(false);
	});
});
