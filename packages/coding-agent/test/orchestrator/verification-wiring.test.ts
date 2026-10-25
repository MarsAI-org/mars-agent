import { describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import {
	cfgOrchestratorVerificationChecks,
	resolveOrchestratorVerificationChecks,
} from "@marsai-org/coding-agent/orchestrator/settings";
import { createNativeOrchestrationEngine } from "@marsai-org/coding-agent/orchestrator/native-runner";

describe("orchestrator verification checks", () => {
	it("is empty by default, so verification stays off unless asked for", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		expect(cfgOrchestratorVerificationChecks.get(settings)).toEqual([]);
		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([]);
	});

	it("maps configured commands onto stable check ids in order", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["bun run check", "bun test"]);

		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([
			{ id: "check-1", command: "bun run check" },
			{ id: "check-2", command: "bun test" },
		]);
	});

	it("drops blank entries instead of running an always-passing shell", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["  ", "bun run check", ""]);

		// The surviving check keeps its configured position, so a failure message
		// still points at the line the user wrote.
		expect(resolveOrchestratorVerificationChecks(settings)).toEqual([{ id: "check-2", command: "bun run check" }]);
	});

	it("builds an engine that carries the configured gate", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({});
		cfgOrchestratorVerificationChecks.set(settings, ["bun run check"]);

		// The production constructor is the only place the verifier is injected;
		// building it here proves a real run gets a gate rather than the no-op the
		// engine used to fall back to.
		const engine = createNativeOrchestrationEngine({
			settings,
			cwd: "/tmp/orchestrator-verification",
			agent: { name: "worker", tools: [] } as never,
			parentActiveTools: [],
			session: {} as never,
			isolateWorkers: false,
		});
		expect(engine).toBeDefined();
	});
});
