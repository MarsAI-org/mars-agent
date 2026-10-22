/**
 * Custom Endpoint & Provider Wizard
 *
 * Two flows share one component:
 *
 * 1. **Override** — point a built-in provider (OpenAI, Anthropic, Ollama, …) at
 *    another host. Writes `providers.endpoints.<id>` in `config.yml`, so the
 *    provider keeps its catalog, credentials, and model list while every
 *    request (and its discovery probe) goes to the configured base URL.
 * 2. **Custom** — register a brand-new provider in `models.yml`, either from a
 *    declared model list or from the endpoint's own `/models` catalog.
 *
 * Reached from `/login` (the picker's last row) and `/endpoint`.
 */
import { Container, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "../index";
import type { Component } from "../tui";
import { getSelectListTheme, theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys, interruptKey } from "../chrome/keybinding-hints";
import { OverlayPanel } from "../chrome/overlay-box";
import { TextFormField, type FormFieldTheme } from "../components/form";
import { SelectList } from "../components/select-list";
import { WizardStep } from "../components/wizard-step";

/** What the wizard hands back once the user confirms. */
export type CustomEndpointWizardResult =
	| { kind: "override"; provider: string; baseUrl: string; apiKey?: string }
	| {
			kind: "custom";
			provider: string;
			baseUrl: string;
			api: string;
			apiKey?: string;
			discovery?: string;
			models?: string[];
	  };

type WizardMode = "override" | "custom";

type WizardStepName =
	| "mode"
	| "builtin-provider"
	| "provider-id"
	| "url"
	| "api-format"
	| "api-key"
	| "discovery-mode"
	| "manual-models"
	| "confirm";

interface WizardChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Prefilled base URL for a built-in provider. */
	readonly defaultUrl?: string;
}

const BUILTIN_PROVIDERS: readonly WizardChoice[] = [
	{
		id: "openai",
		label: "OpenAI",
		description: "Proxy, LiteLLM, vLLM, or a corporate gateway",
		defaultUrl: "https://api.openai.com/v1",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		description: "Claude proxy or gateway",
		defaultUrl: "https://api.anthropic.com",
	},
	{
		id: "google",
		label: "Google Gemini",
		description: "Gemini proxy or regional endpoint",
		defaultUrl: "https://generativelanguage.googleapis.com",
	},
	{
		id: "ollama",
		label: "Ollama",
		description: "Local or remote Ollama server",
		defaultUrl: "http://127.0.0.1:11434",
	},
	{
		id: "lm-studio",
		label: "LM Studio",
		description: "Local LM Studio server",
		defaultUrl: "http://127.0.0.1:1234/v1",
	},
	{
		id: "llama.cpp",
		label: "llama.cpp",
		description: "llama.cpp server",
		defaultUrl: "http://127.0.0.1:8080",
	},
];

const API_FORMATS: readonly WizardChoice[] = [
	{ id: "openai-completions", label: "OpenAI Chat Completions", description: "/v1/chat/completions" },
	{ id: "openai-responses", label: "OpenAI Responses", description: "/v1/responses (Codex, GPT-5)" },
	{ id: "anthropic-messages", label: "Anthropic Messages", description: "/v1/messages" },
	{ id: "google-generative-ai", label: "Google Generative AI", description: "Gemini v1beta REST" },
];

const DISCOVERY_MODES: readonly WizardChoice[] = [
	{
		id: "openai-models-list",
		label: "Discover from the endpoint",
		description: "Read the model list from /v1/models",
	},
	{ id: "none", label: "Declare models myself", description: "Type the model ids the endpoint serves" },
];

const FORM_THEME: FormFieldTheme = {
	label: value => value,
	description: value => theme.fg("muted", value),
	error: value => theme.fg("error", value),
	hint: value => theme.fg("muted", value),
};

/** Display cap for sanitized URLs and error text. */
const MAX_DISPLAY_WIDTH = 120;

function sanitize(value: string): string {
	return truncateToWidth(replaceTabs(value), MAX_DISPLAY_WIDTH);
}

function inputHint(escapeAction: string): string {
	return `[${editorKey("tui.input.submit")} to continue, ${editorKey("tui.select.cancel")} to ${escapeAction}]`;
}

function choiceHint(escapeAction: string): string {
	return `[${editorKeys("tui.select.up", "tui.select.down")} to navigate, ${formatKeyHint("enter")} to select, ${interruptKey()} to ${escapeAction}]`;
}

export class CustomEndpointWizardComponent extends OverlayPanel {
	#contentContainer: Container;
	#currentStep: WizardStepName = "mode";
	#step: WizardStep | null = null;
	#inputField: TextFormField | null = null;
	#selectedIndex = 0;
	#choices: readonly WizardChoice[] = [];
	#history: WizardStepName[] = [];

	// Collected answers.
	#mode: WizardMode = "override";
	#providerId = "openai";
	#baseUrl = "";
	#apiKey = "";
	#api = "openai-completions";
	#discovery = "openai-models-list";
	#models = "";
	#validationError: string | null = null;

	readonly #onCompleteCallback: (result: CustomEndpointWizardResult) => void;
	readonly #onCancelCallback: () => void;
	readonly #onRenderCallback: (() => void) | undefined;

	constructor(
		onComplete: (result: CustomEndpointWizardResult) => void,
		onCancel: () => void,
		onRender?: () => void,
		initialMode?: WizardMode,
	) {
		super("Custom Endpoint", "omp.overlay.customEndpoint");
		this.#onCompleteCallback = onComplete;
		this.#onCancelCallback = onCancel;
		this.#onRenderCallback = onRender;
		if (initialMode) {
			this.#mode = initialMode;
			// Seed the back-stack so Escape from a prefilled first step returns to
			// the flow choice instead of leaving the wizard outright.
			this.#history.push("mode");
			this.#currentStep = initialMode === "override" ? "builtin-provider" : "provider-id";
		}

		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		this.#renderStep();
	}

	#requestRender(): void {
		this.#onRenderCallback?.();
	}

	#show(step: WizardStep): void {
		step.setMaxHeight(undefined);
		this.#step = step;
		this.#contentContainer.clear();
		this.#contentContainer.addChild(step);
		this.#requestRender();
	}

	/** Push the current step, then mount `next` with its selection reset. */
	#goTo(next: WizardStepName): void {
		this.#history.push(this.#currentStep);
		this.#currentStep = next;
		this.#selectedIndex = 0;
		this.#validationError = null;
		this.#renderStep();
	}

	#goBack(): void {
		const previous = this.#history.pop();
		if (!previous) {
			this.#onCancelCallback();
			return;
		}
		this.#currentStep = previous;
		this.#selectedIndex = 0;
		this.#validationError = null;
		this.#renderStep();
	}

	/** Re-render the current step, keeping the highlighted row. */
	#rerender(): void {
		this.#renderStep();
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#step = null;
		this.#inputField = null;
		switch (this.#currentStep) {
			case "mode":
				this.#renderModeStep();
				break;
			case "builtin-provider":
				this.#renderBuiltinProviderStep();
				break;
			case "provider-id":
				this.#renderProviderIdStep();
				break;
			case "url":
				this.#renderUrlStep();
				break;
			case "api-format":
				this.#renderApiFormatStep();
				break;
			case "api-key":
				this.#renderApiKeyStep();
				break;
			case "discovery-mode":
				this.#renderDiscoveryModeStep();
				break;
			case "manual-models":
				this.#renderManualModelsStep();
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#choiceStep(options: {
		heading: string;
		intro?: Component;
		choices: readonly WizardChoice[];
		escape: string;
	}): void {
		this.#choices = options.choices;
		const items = options.choices.map((choice, index) => ({
			value: String(index),
			label: choice.label,
			description: choice.description,
		}));
		const list = new SelectList(items, MAX_DISPLAY_WIDTH * Math.max(1, items.length), getSelectListTheme(), {
			search: "never",
			renderItem: ({ item, selected, width }) => {
				const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const label = selected ? theme.fg("accent", item.label) : item.label;
				const lines = [`${prefix}${label}`];
				if (item.description) lines.push(`    ${theme.fg("dim", item.description)}`);
				return lines.map(line => truncateToWidth(line, width));
			},
		});
		list.setSelectedIndex(this.#selectedIndex);
		list.onSelect = item => this.#selectChoice(Number(item.value));
		list.onCancel = () => this.#goBack();
		this.#show(
			new WizardStep({
				kind: "choice",
				heading: new Text(theme.fg("accent", options.heading), 0, 0),
				intro: options.intro,
				content: list,
				footer: new Text(theme.fg("muted", choiceHint(options.escape)), 0, 0),
			}),
		);
	}

	#inputStep(options: {
		heading: string;
		prompt: string;
		initial: string;
		details?: readonly string[];
		note?: string;
		escape?: string;
		optional?: boolean;
		secret?: boolean;
		onSubmit: (value: string) => void;
	}): void {
		const field = new TextFormField({
			theme: FORM_THEME,
			label: options.prompt,
			details: options.details?.map(detail => new Text(theme.fg("muted", detail), 0, 0)),
			summary: this.#validationError
				? [new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0), new Spacer(1)]
				: undefined,
			hint: options.note
				? `[${options.note}]\n${inputHint(options.escape ?? "back")}`
				: inputHint(options.escape ?? "back"),
			initialValue: options.initial,
			secret: options.secret ?? false,
			empty: options.optional ? "submit" : "reject",
			emptyError: "This value is required.",
			onSubmit: value => options.onSubmit(value.trim()),
			onCancel: () => this.#goBack(),
		});
		this.#inputField = field;
		this.#show(
			new WizardStep({
				kind: "input",
				heading: new Text(theme.fg("accent", options.heading), 0, 0),
				content: field,
			}),
		);
	}

	#renderModeStep(): void {
		this.#choiceStep({
			heading: "Custom endpoint",
			choices: [
				{
					id: "override",
					label: "Override a built-in provider's endpoint",
					description: "Keep the provider's models and credentials; send its requests elsewhere",
				},
				{
					id: "custom",
					label: "Add a new custom provider",
					description: "Register a provider and its models from scratch",
				},
			],
			escape: "cancel",
		});
	}

	#renderBuiltinProviderStep(): void {
		this.#choiceStep({
			heading: "Which provider?",
			choices: BUILTIN_PROVIDERS,
			escape: "back",
		});
	}

	#renderProviderIdStep(): void {
		this.#inputStep({
			heading: "New provider",
			prompt: "Provider id:",
			initial: this.#providerId === "openai" ? "" : this.#providerId,
			details: ["A short lowercase identifier, for example `my-gateway`."],
			onSubmit: value => {
				if (value.length === 0) {
					this.#validationError = "Provider id cannot be empty.";
					this.#rerender();
					return;
				}
				if (/\s/.test(value)) {
					this.#validationError = "Provider id must not contain whitespace.";
					this.#rerender();
					return;
				}
				this.#providerId = value;
				this.#goTo("url");
			},
		});
	}

	#renderUrlStep(): void {
		this.#inputStep({
			heading: `Endpoint for ${this.#providerId}`,
			prompt: "Base URL:",
			initial: this.#baseUrl,
			details: [
				"Absolute http(s) URL, for example https://gateway.example.com/v1.",
				"Requests and model discovery both go to this host.",
			],
			onSubmit: value => {
				let protocol: string;
				try {
					protocol = new URL(value).protocol;
				} catch {
					this.#validationError = "Enter an absolute URL, for example https://gateway.example.com/v1.";
					this.#rerender();
					return;
				}
				if (protocol !== "http:" && protocol !== "https:") {
					this.#validationError = "The URL must use http:// or https://.";
					this.#rerender();
					return;
				}
				this.#baseUrl = value;
				this.#goTo(this.#mode === "override" ? "api-key" : "api-format");
			},
		});
	}

	#renderApiFormatStep(): void {
		this.#choiceStep({ heading: "Wire format", choices: API_FORMATS, escape: "back" });
	}

	#renderApiKeyStep(): void {
		this.#inputStep({
			heading: `Credential for ${this.#providerId}`,
			prompt: "API key:",
			initial: this.#apiKey,
			details: [
				"An environment variable name (e.g. MY_API_KEY), a literal token, or !command.",
				"Leave blank to keep using the environment or an existing login.",
			],
			optional: true,
			secret: true,
			onSubmit: value => {
				this.#apiKey = value;
				this.#goTo(this.#mode === "override" ? "confirm" : "discovery-mode");
			},
		});
	}

	#renderDiscoveryModeStep(): void {
		this.#choiceStep({ heading: "Model list", choices: DISCOVERY_MODES, escape: "back" });
	}

	#renderManualModelsStep(): void {
		this.#inputStep({
			heading: "Models served by this endpoint",
			prompt: "Model ids:",
			initial: this.#models,
			details: ["Comma-separated, for example `chat-v1, code-v2`."],
			onSubmit: value => {
				if (value.length === 0) {
					this.#validationError = "Enter at least one model id.";
					this.#rerender();
					return;
				}
				this.#models = value;
				this.#goTo("confirm");
			},
		});
	}

	#renderConfirmStep(): void {
		const intro = new Container();
		intro.addChild(
			new Text(
				theme.fg(
					"muted",
					this.#mode === "override"
						? "Writes providers.endpoints in config.yml. Models and credentials stay as they are."
						: "Writes a provider block in models.yml.",
				),
				0,
				0,
			),
		);
		intro.addChild(new Spacer(1));
		const rows: string[] = [
			`${theme.fg("muted", "provider")}  ${theme.bold(this.#providerId)}`,
			`${theme.fg("muted", "endpoint")}  ${this.#baseUrl}`,
		];
		if (this.#mode === "custom") {
			rows.push(`${theme.fg("muted", "wire")}      ${this.#api}`);
			rows.push(
				`${theme.fg("muted", "models")}    ${this.#discovery === "none" ? this.#models : "discovered from /models"}`,
			);
		}
		rows.push(`${theme.fg("muted", "credential")} ${this.#apiKey ? "provided" : "inherited"}`);
		for (const row of rows) intro.addChild(new Text(`  ${row}`, 0, 0));

		this.#choiceStep({
			heading: "Save this endpoint?",
			intro,
			choices: [
				{ id: "save", label: "Save and refresh models", description: "Apply now and re-run model discovery" },
				{ id: "cancel", label: "Cancel", description: "Discard these changes" },
			],
			escape: "back",
		});
	}

	#selectChoice(index: number): void {
		const choice = this.#choices[index];
		if (!choice) return;
		switch (this.#currentStep) {
			case "mode": {
				this.#mode = choice.id as WizardMode;
				this.#goTo(this.#mode === "override" ? "builtin-provider" : "provider-id");
				return;
			}
			case "builtin-provider": {
				this.#providerId = choice.id;
				this.#baseUrl = choice.defaultUrl ?? "";
				this.#goTo("url");
				return;
			}
			case "api-format": {
				this.#api = choice.id;
				this.#goTo("api-key");
				return;
			}
			case "discovery-mode": {
				this.#discovery = choice.id;
				this.#goTo(choice.id === "none" ? "manual-models" : "confirm");
				return;
			}
			case "confirm": {
				if (choice.id === "save") this.#submit();
				else this.#onCancelCallback();
				return;
			}
		}
	}

	#submit(): void {
		if (this.#mode === "override") {
			this.#onCompleteCallback({
				kind: "override",
				provider: this.#providerId,
				baseUrl: this.#baseUrl,
				apiKey: this.#apiKey.length > 0 ? this.#apiKey : undefined,
			});
			return;
		}
		const models =
			this.#discovery === "none"
				? this.#models
						.split(",")
						.map(entry => entry.trim())
						.filter(entry => entry.length > 0)
				: undefined;
		this.#onCompleteCallback({
			kind: "custom",
			provider: this.#providerId,
			baseUrl: this.#baseUrl,
			api: this.#api,
			apiKey: this.#apiKey.length > 0 ? this.#apiKey : undefined,
			discovery: this.#discovery === "none" ? undefined : this.#discovery,
			models,
		});
	}

	handleInput(keyData: string): void {
		// Ctrl+C always abandons the wizard, matching every other overlay.
		if (keyData === "\x03") {
			this.#onCancelCallback();
			return;
		}
		// A text field owns Enter/Escape and every printable key while focused.
		if (this.#inputField) {
			this.#step?.handleInput(keyData);
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			this.#goBack();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectChoice(this.#selectedIndex);
			return;
		}
		if (matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
	}

	#moveSelection(delta: number): void {
		const count = this.#choices.length;
		if (count === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + count) % count;
		// Choice rows are rebuilt per step, so re-render to move the highlight.
		this.#renderStep();
	}
}
