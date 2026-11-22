/**
 * Integration-phase contracts for the orchestration engine.
 *
 * No test reaches a model or spawns a worker: the runner is a fake and the
 * integrator records what it was asked to land.
 */

import { describe, expect, test } from "bun:test";
import {
	OrchestrationEngine,
	type EngineRunner,
	type IntegrationReport,
	type Integrator,
	type PendingIntegration,
} from "../../src/orchestrator/engine";
import type { OrchestratorPlan, WorkerChanges, WorkerOutcome, WorkerSpec } from "../../src/orchestrator/types";

class FakeIntegrator implements Integrator {
	calls: PendingIntegration[][] = [];
	constructor(private readonly report: IntegrationReport) {}
	async integrate(pending: readonly PendingIntegration[]): Promise<IntegrationReport> {
		this.calls.push([...pending]);
		return this.report;
	}
}

class FailingIntegrator implements Integrator {
	async integrate(): Promise<IntegrationReport> {
		throw new Error("cherry-pick conflict in src/a.ts");
	}
}

/** A runner that returns whatever the test configured, keyed by task id. */
class OutcomeRunner implements EngineRunner {
	constructor(private readonly outcomes: Readonly<Record<string, WorkerOutcome>>) {}
	async run(_spec: WorkerSpec, task: { id: string }): Promise<WorkerOutcome> {
		return this.outcomes[task.id] ?? { exitCode: 0, output: "ok" };
	}
}

function worker(id: string, isolated = true): WorkerSpec {
	return { id, roleLabel: id, backend: "native", isolated };
}

function plan(tasks: readonly OrchestratorPlan["tasks"][number][], workers?: WorkerSpec[]): OrchestratorPlan {
	return { id: "plan-integrate", goal: "integrate", tasks, workers: workers ?? [worker("w1")] };
}

function task(id: string, dependencies: string[] = []): OrchestratorPlan["tasks"][number] {
	return { id, title: id, description: `do ${id}`, dependencies, targetFiles: [`src/${id}.ts`] };
}

function committed(branch: string, baseSha = "abc123"): WorkerOutcome {
	const changes: WorkerChanges = { branchName: branch, baseSha, hasChanges: true };
	return { exitCode: 0, output: "done", changes };
}

describe("engine integration phase", () => {
	test("lands one branch per completed isolated task", async () => {
		const integrator = new FakeIntegrator({ merged: ["feature-a"], failed: [] });
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({ a: committed("feature-a") }),
			integrator,
		});

		const report = await engine.run(plan([task("a")]));

		expect(integrator.calls).toHaveLength(1);
		expect(integrator.calls[0]).toHaveLength(1);
		expect(integrator.calls[0]?.[0]).toMatchObject({
			taskId: "a",
			workerId: "w1",
			branchName: "feature-a",
			baseSha: "abc123",
		});
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("does not integrate a worker that produced no branch", async () => {
		const integrator = new FakeIntegrator({ merged: [], failed: [] });
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({ a: { exitCode: 0, output: "no changes" } }),
			integrator,
		});

		await engine.run(plan([task("a")]));

		// Nothing to merge, so the integrator is never consulted.
		expect(integrator.calls).toHaveLength(0);
	});

	test("does not integrate a failed task", async () => {
		const integrator = new FakeIntegrator({ merged: [], failed: [] });
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({
				a: { exitCode: 1, output: "", error: "boom", changes: { branchName: "feature-a", hasChanges: true } },
			}),
			integrator,
		});

		const report = await engine.run(plan([task("a")]));

		expect(integrator.calls).toHaveLength(0);
		expect(report.outcomes.get("a")?.state).toBe("failed");
	});

	test("a branch that fails to merge demotes its task to failed", async () => {
		const integrator = new FakeIntegrator({ merged: [], failed: ["feature-a"], summary: "conflict" });
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({ a: committed("feature-a") }),
			integrator,
		});

		const report = await engine.run(plan([task("a")]));

		// The code never reached the target, so the task must not read as done.
		expect(report.outcomes.get("a")?.state).toBe("failed");
	});

	test("one failed merge leaves a sibling's merge intact", async () => {
		const integrator = new FakeIntegrator({ merged: ["feature-a"], failed: ["feature-b"] });
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({
				a: committed("feature-a"),
				b: committed("feature-b"),
			}),
			integrator,
		});

		const report = await engine.run(plan([task("a"), task("b")], [worker("w1"), worker("w2")]));

		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("failed");
	});

	test("an integrator that throws fails every pending task", async () => {
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({ a: committed("feature-a") }),
			integrator: new FailingIntegrator(),
		});

		const report = await engine.run(plan([task("a")]));

		expect(report.outcomes.get("a")?.state).toBe("failed");
	});

	test("no integrator keeps the pre-integration behaviour", async () => {
		const engine = new OrchestrationEngine({ runner: new OutcomeRunner({ a: committed("feature-a") }) });
		const report = await engine.run(plan([task("a")]));
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("exposes the recorded changes for reporting", async () => {
		const engine = new OrchestrationEngine({
			runner: new OutcomeRunner({ a: committed("feature-a") }),
			integrator: new FakeIntegrator({ merged: ["feature-a"], failed: [] }),
		});

		await engine.run(plan([task("a")]));

		expect(engine.changesFor("a")?.branchName).toBe("feature-a");
	});
});
