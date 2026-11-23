import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import {
	applyOrchestratorCommand,
	describeOrchestratorMode,
	type OrchestratorSessionTools,
	setOrchestratorMode,
} from "@marsai-org/coding-agent/orchestrator/mode";
import {
	clearLiveSwarmRuns,
	registerLiveSwarmRun,
	SwarmRunStore,
} from "@marsai-org/coding-agent/orchestrator/run-store";
import {
	cfgOrchestratorEnabled,
	cfgOrchestratorMaxConcurrency,
	cfgOrchestratorMode,
} from "@marsai-org/coding-agent/orchestrator/settings";
import { executeBuiltinSlashCommand } from "@marsai-org/coding-agent/slash-commands/builtin-registry";

/** Fake session: a name list plus the mutations the mode performs. */
function fakeSession(
	initial: string[],
	options: {
		builtIns?: string[];
		registerOnReconcile?: boolean;
	} = {},
) {
	let enabled = [...initial];
	const builtIns = new Set(options.builtIns ?? ["orchestrate", "read", "bash"]);
	let reconcileCalls = 0;
	const session: OrchestratorSessionTools = {
		getEnabledToolNames: () => [...enabled],
		setActiveToolsByName: async names => {
			enabled = [...names];
		},
		hasBuiltInTool: name => builtIns.has(name),
		reconcileBuiltinTools: async () => {
			reconcileCalls += 1;
			if (options.registerOnReconcile) {
				builtIns.add("orchestrate");
			}
		},
	};
	return { session, current: () => enabled, reconcileCalls: () => reconcileCalls };
}

afterEach(() => {
	clearLiveSwarmRuns();
	vi.restoreAllMocks();
});

describe("/swarm and /orchestrate mode", () => {
	it("reconciles builtin tools on /swarm on when session booted with orchestrator disabled", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		// Initially "orchestrate" is NOT in builtIns until reconcileBuiltinTools() runs after setting orchestrator.enabled=true.
		const { session, current, reconcileCalls } = fakeSession(["read", "bash"], {
			builtIns: ["read", "bash"],
			registerOnReconcile: true,
		});

		const on = await setOrchestratorMode(settings, session, true);
		expect(on.enabled).toBe(true);
		expect(on.changed).toBe(true);
		expect(reconcileCalls()).toBe(1);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(current()).toEqual(["read", "bash", "orchestrate"]);

		const off = await setOrchestratorMode(settings, session, false);
		expect(off.enabled).toBe(false);
		expect(off.changed).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
		expect(current()).toEqual(["read", "bash"]);
	});

	it("reverts setting and refuses to enable when reconcile still leaves orchestrate unavailable", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		// Restricted subagent session: reconcileBuiltinTools() runs but still does not register "orchestrate".
		const { session, current, reconcileCalls } = fakeSession(["read"], {
			builtIns: ["read"],
			registerOnReconcile: false,
		});

		const result = await setOrchestratorMode(settings, session, true);
		expect(result.enabled).toBe(false);
		expect(result.changed).toBe(false);
		expect(reconcileCalls()).toBe(1);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
		expect(current()).toEqual(["read"]);
		expect(result.message).toContain("unavailable in this session");
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

	it("reports status with platform-narrowed worker cap on Android and active live run progress", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(describeOrchestratorMode(settings)).toBe("Orchestrator: off");
		cfgOrchestratorEnabled.set(settings, true);
		cfgOrchestratorMode.set(settings, "parallel");
		cfgOrchestratorMaxConcurrency.set(settings, 8);
		expect(describeOrchestratorMode(settings, { platform: "linux", env: {} })).toBe(
			"Orchestrator: on (parallel, up to 8 workers)",
		);
		// Android narrows effective concurrency to ORCHESTRATOR_DEFAULT_CONCURRENCY_ANDROID (2).
		const androidStatus = await applyOrchestratorCommand(settings, session, "status", {
			platformContext: { platform: "android", env: {} },
		});
		expect(androidStatus).toBe("Orchestrator: on (parallel, up to 2 workers)");

		// Register an active live run and verify status includes planId and progress.
		const dispose = registerLiveSwarmRun({
			planId: "swarm-live-1",
			goal: "Ship Wave 2",
			startedAt: 1000,
			isActive: () => true,
			stopAll: () => {},
			getSnapshot: () => [
				{ workerId: "w1", label: "w1", state: "completed" },
				{ workerId: "w2", label: "w2", state: "running" },
			],
		});
		try {
			const withRun = await applyOrchestratorCommand(settings, session, "status", {
				platformContext: { platform: "linux", env: {} },
			});
			expect(withRun).toContain("swarm-live-1");
			expect(withRun).toContain("1/2 completed");
		} finally {
			dispose();
		}
	});

	it("sets the fan-out policy and rejects a bad one", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "mode parallel")).toContain("parallel");
		expect(cfgOrchestratorMode.get(settings)).toBe("parallel");

		const bad = await applyOrchestratorCommand(settings, session, "mode sideways");
		expect(bad).toContain("Usage: /swarm mode");
		expect(cfgOrchestratorMode.get(settings)).toBe("parallel");
	});

	it("caps workers between 1 and 64 and rejects out-of-range values", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "workers 12")).toContain("12");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(12);

		const zero = await applyOrchestratorCommand(settings, session, "workers 0");
		expect(zero).toContain("positive integer");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(12);

		const tooHigh = await applyOrchestratorCommand(settings, session, "workers 65");
		expect(tooHigh).toContain("1..64");
		expect(cfgOrchestratorMaxConcurrency.get(settings)).toBe(12);
	});

	it("lists persisted runs from an isolated SwarmRunStore via /swarm runs", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-swarm-mode-test-"));
		try {
			const store = new SwarmRunStore({ baseDir: tempDir, now: () => 1_700_000_000_000 });
			expect(await applyOrchestratorCommand(settings, session, "runs", store)).toBe(
				"No persisted swarm runs found.",
			);

			await store.saveRunStart(
				{
					id: "swarm-alpha",
					goal: "Test persisted run listing",
					tasks: [
						{
							id: "t1",
							title: "Task 1",
							description: "Do task 1",
							dependencies: [],
							targetFiles: ["a.ts"],
						},
					],
					workers: [{ id: "w1", roleLabel: "w1", backend: "native", isolated: false }],
				},
				tempDir,
			);

			const listed = await applyOrchestratorCommand(settings, session, "runs", store);
			expect(listed).toContain("swarm-alpha");
			expect(listed).toContain("[running]");
			expect(listed).toContain("Test persisted run listing");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("treats a bare command as status and names unknown verbs", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);

		expect(await applyOrchestratorCommand(settings, session, "")).toBe("Orchestrator: off");
		const unknown = await applyOrchestratorCommand(settings, session, "bogus");
		expect(unknown).toContain('Unknown /swarm subcommand "bogus"');
		expect(unknown).toContain("on — enable orchestrator mode");
	});

	it("dispatches both /swarm and /orchestrate alias through the slash-command registry", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session, current } = fakeSession(["read"], {
			builtIns: ["read"],
			registerOnReconcile: true,
		});
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

		const handledSwarm = await executeBuiltinSlashCommand("/swarm on", { ctx } as never);
		expect(handledSwarm).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(true);
		expect(current()).toContain("orchestrate");
		expect(String(showStatus.mock.calls.at(-1)?.[0] ?? "")).toContain("Orchestrator mode on");

		const handledAlias = await executeBuiltinSlashCommand("/orchestrate off", { ctx } as never);
		expect(handledAlias).toBe(true);
		expect(cfgOrchestratorEnabled.get(settings)).toBe(false);
		expect(current()).not.toContain("orchestrate");
	});

	it("mounts the live Swarm Board overlay on /swarm board and detaches on q without stopping the run", async () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		const { session } = fakeSession(["read"]);
		let stopped = false;
		const dispose = registerLiveSwarmRun({
			planId: "swarm-overlay-run",
			goal: "Live Board Overlay",
			startedAt: 1000,
			isActive: () => !stopped,
			stopAll: () => {
				stopped = true;
			},
			getSnapshot: () => [{ workerId: "w1", label: "Worker 1", state: "running" }],
		});

		try {
			const hide = vi.fn();
			let mountedComponent: { handleInput(data: string): void; dispose(): void } | undefined;
			const showOverlay = vi.fn(comp => {
				mountedComponent = comp;
				return { hide };
			});
			const ctx = {
				settings,
				session,
				editor: { setText: vi.fn(), clearDraft: vi.fn() },
				showStatus: vi.fn(),
				showError: vi.fn(),
				ui: {
					terminal: { rows: 24, columns: 100 },
					requestRender: vi.fn(),
					showOverlay,
					setFocus: vi.fn(),
				},
				statusLine: { invalidate: vi.fn() },
				input: undefined,
			};

			const handled = await executeBuiltinSlashCommand("/swarm board", { ctx } as never);
			expect(handled).toBe(true);
			expect(showOverlay).toHaveBeenCalledTimes(1);
			expect(mountedComponent).toBeDefined();

			// Pressing 'q' detaches (hides overlay) without stopping the live run.
			mountedComponent?.handleInput("q");
			expect(hide).toHaveBeenCalledTimes(1);
			expect(stopped).toBe(false);
		} finally {
			dispose();
		}
	});
});
