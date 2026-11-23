import { describe, expect, it } from "bun:test";
import { OrchestrationEngine, type EngineRunner, type Integrator } from "@marsai-org/coding-agent/orchestrator/engine";
import { NoopVerifier } from "@marsai-org/coding-agent/orchestrator/verifier";
import type { OrchestratorPlan, WorkerOutcome } from "@marsai-org/coding-agent/orchestrator/types";

const plan: OrchestratorPlan = {
	id: "report-fields",
	goal: "report what the worker did",
	tasks: [{ id: "t1", title: "t1", description: "do it", dependencies: [], targetFiles: [] }],
	workers: [{ id: "w1", roleLabel: "w1", backend: "native", isolated: false }],
};

class OutputRunner implements EngineRunner {
	async run(): Promise<WorkerOutcome> {
		return { exitCode: 0, output: "the worker output" };
	}
}

class ThrowingRunner implements EngineRunner {
	async run(): Promise<WorkerOutcome> {
		throw new Error("spawn failed");
	}
}

describe("engine report fields", () => {
	it("keeps the worker output and attempts count in the report", async () => {
		const report = await new OrchestrationEngine({ runner: new OutputRunner() }).run(plan);
		expect(report.outcomes.get("t1")?.outcome?.output).toBe("the worker output");
		expect(report.outcomes.get("t1")?.attempts).toBe(1);
	});

	it("carries the engine error for a worker that threw", async () => {
		const report = await new OrchestrationEngine({ runner: new ThrowingRunner() }).run(plan);
		const record = report.outcomes.get("t1");
		expect(record?.state).toBe("failed");
		expect(record?.error).toBe("spawn failed");
	});

	it("carries the verification verdict so a rejection is not a bare 'failed'", async () => {
		const report = await new OrchestrationEngine({
			runner: new OutputRunner(),
			verifier: new NoopVerifier(),
			verificationChecks: [{ id: "chk", command: "exit 0" }],
			verificationRoot: process.cwd(),
		}).run(plan);
		const record = report.outcomes.get("t1");
		expect(record?.state).toBe("completed");
		expect(record?.verification?.ok).toBe(true);
	});

	it("surfaces branch integration failure details in TaskOutcomeRecord.error and supports patchPath-only outcomes", async () => {
		const conflictIntegrator: Integrator = {
			async integrate() {
				return { merged: [], failed: ["branch-t1"], summary: "cherry-pick conflict in src/a.ts" };
			},
		};
		const branchRunner: EngineRunner = {
			async run(): Promise<WorkerOutcome> {
				return {
					exitCode: 0,
					output: "done",
					changes: { branchName: "branch-t1", hasChanges: true },
				};
			},
		};
		const failedReport = await new OrchestrationEngine({
			runner: branchRunner,
			integrator: conflictIntegrator,
		}).run(plan);
		expect(failedReport.outcomes.get("t1")?.state).toBe("failed");
		expect(failedReport.outcomes.get("t1")?.error).toBe("cherry-pick conflict in src/a.ts");

		// A patchPath-only outcome is recorded cleanly without failing integration.
		const patchRunner: EngineRunner = {
			async run(): Promise<WorkerOutcome> {
				return {
					exitCode: 0,
					output: "patched",
					changes: { patchPath: "/tmp/t1.patch", hasChanges: true },
				};
			},
		};
		const patchEngine = new OrchestrationEngine({
			runner: patchRunner,
			integrator: conflictIntegrator,
		});
		const patchReport = await patchEngine.run(plan);
		expect(patchReport.outcomes.get("t1")?.state).toBe("completed");
		expect(patchEngine.changesFor("t1")?.mergeSummary).toContain("/tmp/t1.patch");
	});
});
