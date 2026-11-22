import { describe, expect, it } from "bun:test";
import { OAuthManualInputManager } from "@marsai-org/coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@marsai-org/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@marsai-org/coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext };
	getStatus: () => string | undefined;
	getWarning: () => string | undefined;
	getSelectorMode: () => "login" | "logout" | undefined;
	getSelectorProvider: () => string | undefined;
	getEndpointWizardCalls: () => number;
};

const createRuntimeHarness = (manualInput: OAuthManualInputManager): RuntimeHarness => {
	let statusMessage: string | undefined;
	let warningMessage: string | undefined;
	let selectorMode: "login" | "logout" | undefined;
	let selectorProvider: string | undefined;
	let endpointWizardCalls = 0;
	const ctx = {
		oauthManualInput: manualInput,
		editor: {
			setText: () => {},
		} as unknown as InteractiveModeContext["editor"],
		showStatus: (message: string) => {
			statusMessage = message;
		},
		showWarning: (message: string) => {
			warningMessage = message;
		},
		showOAuthSelector: async (mode: "login" | "logout", providerId?: string) => {
			selectorMode = mode;
			selectorProvider = providerId;
		},
		showCustomEndpointWizard: async () => {
			endpointWizardCalls += 1;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
		},
		getStatus: () => statusMessage,
		getWarning: () => warningMessage,
		getSelectorMode: () => selectorMode,
		getSelectorProvider: () => selectorProvider,
		getEndpointWizardCalls: () => endpointWizardCalls,
	};
};

describe("/login slash command", () => {
	it("submits manual callback URL without opening selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const callbackUrl = "http://localhost:1455/auth/callback?code=abc&state=xyz";
		const pending = manualInput.waitForInput("openai-codex");
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand(`/login ${callbackUrl}`, harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getStatus()).toBe("OAuth callback received; completing login…");
		expect(await pending).toBe(callbackUrl);
	});

	it("opens selector when no args are provided", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
	});

	it("routes /login kagi to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});

	it("routes /login parallel to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login parallel", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("parallel");
	});

	it.each(["custom", "endpoint", "custom-endpoint"])(
		"routes /login %s to the custom endpoint wizard instead of a provider",
		async alias => {
			const manualInput = new OAuthManualInputManager();
			const harness = createRuntimeHarness(manualInput);

			const handled = await executeBuiltinSlashCommand(`/login ${alias}`, harness.runtime);

			expect(handled).toBe(true);
			expect(harness.getEndpointWizardCalls()).toBe(1);
			expect(harness.getSelectorMode()).toBeUndefined();
		},
	);

	it("opens the custom endpoint wizard from /endpoint", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/endpoint", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getEndpointWizardCalls()).toBe(1);
		expect(harness.getSelectorMode()).toBeUndefined();
	});

	it("warns when no pending login exists for manual callback", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login http://localhost/callback", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getWarning()).toBe("No OAuth login is waiting for a manual callback.");
	});
});
