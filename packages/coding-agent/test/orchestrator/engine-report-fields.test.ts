import { describe, expect, it } from "bun:test";
import { OrchestrationEngine, type EngineRunner } from "@marsai-org/coding-agent/orchestrator/engine";
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
	it("keeps the worker output in the report", async () => {
		// The settlement queue is drained by the scheduler, so a report that read it
		// afterwards lost the output entirely and callers saw `{state, workerId}`.
		const report = await new OrchestrationEngine({ runner: new OutputRunner() }).run(plan);
		expect(report.outcomes.get("t1")?.outcome?.output).toBe("the worker output");
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
});
