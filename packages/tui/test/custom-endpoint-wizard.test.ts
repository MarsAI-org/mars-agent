import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@marsai-org/tui/app-keybindings";
import {
	CustomEndpointWizardComponent,
	type CustomEndpointWizardResult,
} from "@marsai-org/tui/overlays/custom-endpoint-wizard";
import { getThemeByName, setThemeInstance } from "@marsai-org/tui/theme";
import { setKeybindings } from "@marsai-org/tui";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\n";
const ESC = "\x1b";

let darkTheme = await getThemeByName("dark");

function render(wizard: CustomEndpointWizardComponent): string {
	return stripVTControlCharacters(wizard.render(100).join("\n"));
}

function mount(initialMode?: "override" | "custom"): {
	wizard: CustomEndpointWizardComponent;
	onComplete: ReturnType<typeof vi.fn>;
	onCancel: ReturnType<typeof vi.fn>;
} {
	const onComplete = vi.fn<(result: CustomEndpointWizardResult) => void>();
	const onCancel = vi.fn<() => void>();
	const wizard = new CustomEndpointWizardComponent(onComplete, onCancel, undefined, initialMode);
	return { wizard, onComplete, onCancel };
}

/** Type `text` into the focused text field, one key at a time. */
function type(wizard: CustomEndpointWizardComponent, text: string): void {
	for (const char of text) wizard.handleInput(char);
}

describe("CustomEndpointWizardComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("offers both flows and starts on the choice", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard } = mount();
		const view = render(wizard);
		expect(view).toContain("Override a built-in provider");
		expect(view).toContain("Add a new custom provider");
	});

	it("overrides a built-in provider without touching models.yml", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount();

		wizard.handleInput(ENTER); // choose "override"
		wizard.handleInput(ENTER); // choose OpenAI (first entry)
		// Prefilled URL is selected; clear it and type a proxy instead.
		for (let i = 0; i < 40; i++) wizard.handleInput("\x7f");
		type(wizard, "https://proxy.example.com/v1");
		wizard.handleInput(ENTER); // URL accepted
		wizard.handleInput(ENTER); // blank credential
		wizard.handleInput(ENTER); // "save"

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete.mock.calls[0]?.[0]).toEqual({
			kind: "override",
			provider: "openai",
			baseUrl: "https://proxy.example.com/v1",
			apiKey: undefined,
		});
	});

	it("registers a custom provider from a declared model list", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount("custom");

		type(wizard, "acme");
		wizard.handleInput(ENTER); // provider id
		type(wizard, "https://acme.example.com/v1");
		wizard.handleInput(ENTER); // URL
		wizard.handleInput(ENTER); // wire format: openai-completions
		type(wizard, "ACME_KEY");
		wizard.handleInput(ENTER); // credential
		wizard.handleInput(DOWN); // discovery: "declare models myself"
		wizard.handleInput(ENTER);
		type(wizard, "chat-v1, code-v2");
		wizard.handleInput(ENTER); // model ids
		wizard.handleInput(ENTER); // save

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete.mock.calls[0]?.[0]).toEqual({
			kind: "custom",
			provider: "acme",
			baseUrl: "https://acme.example.com/v1",
			api: "openai-completions",
			apiKey: "ACME_KEY",
			discovery: undefined,
			models: ["chat-v1", "code-v2"],
		});
	});

	it("keeps discovery enabled when the default is accepted", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount("custom");

		type(wizard, "gw");
		wizard.handleInput(ENTER);
		type(wizard, "https://gw.example.com/v1");
		wizard.handleInput(ENTER);
		wizard.handleInput(ENTER); // wire format
		wizard.handleInput(ENTER); // no credential
		wizard.handleInput(ENTER); // discovery: endpoint list
		wizard.handleInput(ENTER); // save

		expect(onComplete.mock.calls[0]?.[0]).toEqual({
			kind: "custom",
			provider: "gw",
			baseUrl: "https://gw.example.com/v1",
			api: "openai-completions",
			apiKey: undefined,
			discovery: "openai-models-list",
			models: undefined,
		});
	});

	it("rejects a relative URL and stays on the URL step", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount("override");

		wizard.handleInput(ENTER); // OpenAI
		for (let i = 0; i < 40; i++) wizard.handleInput("\x7f");
		type(wizard, "proxy.example.com/v1");
		wizard.handleInput(ENTER);

		expect(onComplete).not.toHaveBeenCalled();
		expect(render(wizard)).toContain("absolute URL");
	});

	it("goes back one step on Escape without leaving the wizard", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onCancel } = mount("custom");

		expect(render(wizard)).toContain("Provider id:");
		wizard.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();
		// Back at the mode choice.
		expect(render(wizard)).toContain("Add a new custom provider");
	});

	it("cancels from the first step with Ctrl+C", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onCancel } = mount();
		wizard.handleInput("\x03");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("moves the highlight with the arrow keys", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount("override");

		wizard.handleInput(DOWN); // Anthropic
		wizard.handleInput(ENTER);
		for (let i = 0; i < 40; i++) wizard.handleInput("\x7f");
		type(wizard, "https://claude.example.com");
		wizard.handleInput(ENTER);
		wizard.handleInput(ENTER);
		wizard.handleInput(ENTER);

		expect(onComplete.mock.calls[0]?.[0]).toMatchObject({ provider: "anthropic" });
	});

	it("wraps the highlight around the list", () => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const { wizard, onComplete } = mount("override");

		wizard.handleInput(UP); // wraps to the last built-in provider
		wizard.handleInput(ENTER);
		for (let i = 0; i < 40; i++) wizard.handleInput("\x7f");
		type(wizard, "http://127.0.0.1:8080");
		wizard.handleInput(ENTER);
		wizard.handleInput(ENTER);
		wizard.handleInput(ENTER);

		expect(onComplete.mock.calls[0]?.[0]).toMatchObject({ provider: "llama.cpp" });
	});
});
