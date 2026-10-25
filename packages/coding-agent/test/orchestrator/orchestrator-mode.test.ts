import { describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import {
	applyOrchestratorCommand,
	describeOrchestratorMode,
	type OrchestratorSessionTools,
	setOrchestratorMode,
} from "@marsai-org/coding-agent/orchestrator/mode";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMode,
} from "@marsai-org/coding-agent/orchestrator/settings";
import { executeBuiltinSlashCommand } from "@marsai-org/coding-agent/slash-commands/builtin-registry";
/** Fake session: a name list plus the two mutations the mode performs. */
function fakeSession(initial: string[], builtIns = ["orchestrate", "read", "bash"]) {
	let enabled = [...initial];
	const session: OrchestratorSessionTools = {
		getEnabledToolNames: () => [...enabled],
		setActiveToolsByName: async names => {
			enabled = [...names];
		},
		hasBuiltInTool: name => builtIns.includes(name),
	};
	return { session, current: () => enabled };
}

describe("/orchestrate mode", () => {
	it("exposes the tool on enable and drops only that tool on disable", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session, current } = fakeSession(["read", "bash"]);

		const on = await setOrchestratorMode(settings, session, true);
		expect(on.changed).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(current()).toEqual(["read", "bash", "orchestrate"]);

		const off = await setOrchestratorMode(settings, session, false);
		expect(off.changed).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
		// Every other selection survives: enabling is not a toolset reset.
		expect(current()).toEqual(["read", "bash"]);
	});

	it("is idempotent", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		await setOrchestratorMode(settings, session, true);
		const again = await setOrchestratorMode(settings, session, true);
		expect(again.changed).toBe(false);
		expect(again.message).toContain("already on");
	});

	it("reports status with the fan-out policy and worker cap", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(describeOrchestratorMode(settings)).toBe("Orchestrator: off");
		cfgOrchestratorEnabled.set(settings, true);
		cfgOrchestratorMode.set(settings, "parallel");
		cfgOrchestratorMaxConcurrency.set(settings, 8);
		expect(describeOrchestratorMode(settings)).toBe("Orchestrator: on (parallel, up to 8 workers)");
		expect(session.getEnabledToolNames()).toEqual(["read"]);
	});

	it("sets the fan-out policy and rejects a bad one", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "mode parallel")).toContain("parallel");
		expect(cfgOrchestratorMode.get(settings)).toBe("parallel");

		const bad = await applyOrchestratorCommand(settings, session, "mode sideways");
		expect(bad).toContain("Usage: /orchestrate mode");
		// Unchanged on rejection.
		expect(cfgOrchestratorMode.get(settings)).toBe("parallel");
	});

	it("caps workers and rejects a non-positive value", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "workers 12")).toContain("12");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(12);

		const bad = await applyOrchestratorCommand(settings, session, "workers 0");
		expect(bad).toContain("positive integer");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(12);
	});

	it("treats a bare /orchestrate as status and names unknown verbs", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "")).toBe("Orchestrator: off");
		const unknown = await applyOrchestratorCommand(settings, session, "swarm");
		expect(unknown).toContain('Unknown /orchestrate subcommand "swarm"');
		expect(unknown).toContain("on — enable orchestrator mode");
	});

	it("surfaces through the slash-command dispatcher", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session, current } = fakeSession(["read"]);
		const showStatus = vi.fn();
		const ctx = {
			settings,
			session,
			editor: { setText: vi.fn(), clearDraft: vi.fn() },
			showStatus,
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			input: undefined,
		};

		const handled = await executeBuiltinSlashCommand("/orchestrate on", { ctx } as never);
		expect(handled).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(current()).toContain("orchestrate");
		expect(String(showStatus.mock.calls.at(-1)?.[0] ?? "")).toContain("Orchestrator mode on");
	});
});
