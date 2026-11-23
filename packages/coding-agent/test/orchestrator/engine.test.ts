/**
 * Engine contracts (all runs use a fake runner; no test reaches a model):
 * - independent tasks start concurrently up to the cap across distinct workers (1 active task per worker)
 * - scheduling order is deterministic for the same plan
 * - overlapping write leases serialize the workers instead of corrupting files
 * - global stop cancels pending work, aborts running workers (settling as cancelled), and skips integration
 * - wall-clock and mid-flight token budgets abort running workers on time
 * - verification failures retry up to maxRetries with diagnostic feedback
 * - dynamic addTask and cancelWorker steer an active run
 * - upstream isolated dependencies integrate incrementally before downstream tasks start, and remaining branches land in topological order
 */

import { describe, expect, test } from "bun:test";
import {
	OrchestrationEngine,
	type EngineRunner,
	type IntegrationReport,
	type Integrator,
	type PendingIntegration,
	type WorkerRunContext,
} from "../../src/orchestrator/engine";
import { InMemoryMessageTransport } from "../../src/orchestrator/message-bus";
import type {
	OrchestratorEvent,
	OrchestratorPlan,
	OrchestratorTask,
	WorkerOutcome,
	WorkerSpec,
} from "../../src/orchestrator/types";
import type { VerificationCheck, VerificationResult, Verifier } from "../../src/orchestrator/verifier";

interface Start {
	readonly spec: WorkerSpec;
	readonly taskId: string;
	readonly attempt: number;
	readonly retryFeedback?: string;
}

class FakeRunner implements EngineRunner {
	readonly starts: Start[] = [];
	readonly gates = new Map<string, PromiseWithResolvers<WorkerOutcome>>();
	readonly contexts = new Map<string, WorkerRunContext>();
	/** Usage the runner reports for a task when it finishes. */
	usage = new Map<string, { totalTokens: number; requests: number }>();
	abortReasons: string[] = [];

	async run(spec: WorkerSpec, task: OrchestratorTask, context: WorkerRunContext): Promise<WorkerOutcome> {
		this.starts.push({
			spec,
			taskId: task.id,
			attempt: context.attempt,
			retryFeedback: context.retryFeedback,
		});
		this.contexts.set(task.id, context);
		const gate = Promise.withResolvers<WorkerOutcome>();
		this.gates.set(task.id, gate);
		context.signal.addEventListener(
			"abort",
			() => {
				this.abortReasons.push(String(context.signal.reason));
				gate.resolve({ exitCode: 1, output: "", error: "aborted" });
			},
			{ once: true },
		);
		return gate.promise;
	}

	finish(
		taskId: string,
		outcome: WorkerOutcome = { exitCode: 0, output: `${taskId} done`, usage: this.usage.get(taskId) },
	): void {
		this.gates.get(taskId)?.resolve(outcome);
	}

	contextFor(taskId: string): WorkerRunContext {
		const context = this.contexts.get(taskId);
		if (!context) throw new Error(`task ${taskId} has not started`);
		return context;
	}
}

function worker(id: string, isolated = false): WorkerSpec {
	return { id, roleLabel: id, backend: "native", isolated };
}

function plan(
	tasks: readonly OrchestratorPlan["tasks"][number][],
	workers: readonly WorkerSpec[] = [worker("w1"), worker("w2")],
): OrchestratorPlan {
	return { id: "plan-1", goal: "test", tasks, workers };
}

function task(
	id: string,
	dependencies: readonly string[] = [],
	targetFiles: readonly string[] = [],
	agent?: string,
): OrchestratorPlan["tasks"][number] {
	return { id, title: id, description: `do ${id}`, dependencies, targetFiles, ...(agent ? { agent } : {}) };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(1);
	}
}

describe("OrchestrationEngine", () => {
	test("runs independent tasks concurrently across distinct workers and reports outcomes", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2 });
		const reportPromise = engine.run(plan([task("a", [], ["packages/a/x.ts"]), task("b", [], ["packages/b/y.ts"])]));
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts.map(start => start.taskId)).toEqual(["a", "b"]);
		expect(runner.starts.map(start => start.spec.id)).toEqual(["w1", "w2"]);

		runner.finish("a");
		runner.finish("b");
		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("completed");
		expect(report.stoppedReason).toBeUndefined();
	});

	test("enforces at most 1 active task per worker when multiple tasks target the same worker", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 4 });
		const reportPromise = engine.run(
			plan([task("a", [], ["src/a.ts"], "w1"), task("b", [], ["src/b.ts"], "w1")], [worker("w1")]),
		);
		await waitFor(() => runner.starts.length === 1);
		expect(runner.starts[0]?.taskId).toBe("a");

		// Even with concurrency: 4 and disjoint files, w1 is busy so task b waits.
		await Bun.sleep(10);
		expect(runner.starts.length).toBe(1);

		runner.finish("a");
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts[1]?.taskId).toBe("b");
		runner.finish("b");
		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("completed");
	});

	test("holds a dependent task until its dependency completes", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2 });
		const reportPromise = engine.run(plan([task("first"), task("second", ["first"])]));
		await waitFor(() => runner.starts.length === 1);
		expect(runner.starts.map(start => start.taskId)).toEqual(["first"]);

		runner.finish("first");
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts.map(start => start.taskId)).toEqual(["first", "second"]);
		runner.finish("second");
		await reportPromise;
	});

	test("respects the concurrency cap", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2 });
		const reportPromise = engine.run(
			plan([task("a"), task("b"), task("c")], [worker("w1"), worker("w2"), worker("w3")]),
		);
		await waitFor(() => runner.starts.length === 2);
		expect(runner.gates.size).toBe(2);

		runner.finish("a");
		await waitFor(() => runner.starts.length === 3);
		expect(runner.starts.map(start => start.taskId)).toEqual(["a", "b", "c"]);
		runner.finish("b");
		runner.finish("c");
		await reportPromise;
	});

	test("serializes workers that declare the same write target", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 4 });
		const reportPromise = engine.run(
			plan(
				[task("a", [], ["src/shared.ts"]), task("b", [], ["./src/dir/../shared.ts"])],
				[worker("w1"), worker("w2")],
			),
		);
		await waitFor(() => runner.starts.length === 1);
		expect(runner.starts[0]?.taskId).toBe("a");

		runner.finish("a");
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts.map(start => start.taskId)).toEqual(["a", "b"]);
		runner.finish("b");
		const report = await reportPromise;
		expect(report.outcomes.get("b")?.state).toBe("completed");
	});

	test("global stop cancels pending tasks, settles aborted workers as cancelled, and skips integration", async () => {
		const runner = new FakeRunner();
		let integrateCalled = false;
		const integrator: Integrator = {
			async integrate() {
				integrateCalled = true;
				return { merged: [], failed: [] };
			},
		};
		const engine = new OrchestrationEngine({ runner, concurrency: 1, integrator });
		const reportPromise = engine.run(plan([task("a"), task("b")], [worker("w1", true)]));
		await waitFor(() => runner.starts.length === 1);

		engine.stopAll("user requested stop");
		await waitFor(() => runner.abortReasons.length === 1);
		const report = await reportPromise;
		expect(report.stoppedReason).toBe("user requested stop");
		expect(report.outcomes.get("a")?.state).toBe("cancelled");
		expect(report.outcomes.get("b")?.state).toBe("cancelled");
		expect(runner.abortReasons[0]).toContain("user requested stop");
		expect(integrateCalled).toBe(false);
	});

	test("wall-clock budget timer wakes the scheduler and aborts hung workers", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({
			runner,
			concurrency: 1,
			budget: { maxWallClockMs: 30 },
		});
		const report = await engine.run(plan([task("hung")], [worker("w1")]));
		expect(report.stoppedReason).toContain("wall-clock budget exceeded");
		expect(report.outcomes.get("hung")?.state).toBe("cancelled");
		expect(runner.abortReasons[0]).toContain("wall-clock budget exceeded");
	});

	test("token budget exhaustion stops the run before new workers start and mid-flight via reportProgress", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2, budget: { maxTokens: 1000 } });
		const events: OrchestratorEvent[] = [];
		engine.subscribe(event => events.push(event));
		const reportPromise = engine.run(plan([task("a"), task("b"), task("c")], [worker("w1"), worker("w2")]));
		await waitFor(() => runner.starts.length === 2);

		// Report mid-flight usage from task a that hits the 1000 token ceiling.
		runner.contextFor("a").reportProgress?.({
			outputLine: "halfway",
			usage: { inputTokens: 600, outputTokens: 400 },
		});
		const report = await reportPromise;
		expect(report.stoppedReason).toContain("token budget exceeded");
		expect(report.outcomes.get("a")?.state).toBe("cancelled");
		expect(report.outcomes.get("b")?.state).toBe("cancelled");
		expect(report.outcomes.get("c")?.state).toBe("cancelled");
		expect(events.filter(event => event.type === "budget_exhausted")).toHaveLength(1);
	});

	test("retries a task when verification fails up to maxRetries and passes retryFeedback", async () => {
		let verifyCalls = 0;
		const verifier: Verifier = {
			async verify(_root: string, checks: readonly VerificationCheck[]): Promise<VerificationResult> {
				verifyCalls += 1;
				const ok = verifyCalls >= 2;
				return {
					ok,
					checks: [
						{
							id: checks[0]?.id ?? "check-1",
							command: checks[0]?.command ?? "bun test",
							ok,
							exitCode: ok ? 0 : 1,
							output: ok ? "all pass" : "FAIL: expected 1 to be 2",
							durationMs: 5,
						},
					],
					...(ok ? {} : { firstFailure: checks[0]?.id ?? "check-1" }),
				};
			},
		};
		const runner = new FakeRunner();
		const events: OrchestratorEvent[] = [];
		const engine = new OrchestrationEngine({
			runner,
			maxRetries: 1,
			verifier,
			verificationChecks: [{ id: "check-1", command: "bun test" }],
		});
		engine.subscribe(e => events.push(e));

		const reportPromise = engine.run(plan([task("a")], [worker("w1")]));
		await waitFor(() => runner.starts.length === 1);
		expect(runner.starts[0]?.attempt).toBe(1);
		expect(runner.starts[0]?.retryFeedback).toBeUndefined();

		runner.finish("a", { exitCode: 0, output: "attempt 1" });
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts[1]?.attempt).toBe(2);
		expect(runner.starts[1]?.retryFeedback).toContain("FAIL: expected 1 to be 2");

		runner.finish("a", { exitCode: 0, output: "attempt 2" });
		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("a")?.attempts).toBe(2);
		expect(events.some(e => e.type === "task_retry")).toBe(true);
	});

	test("cancelWorker aborts only the targeted worker and addTask schedules new tasks dynamically", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2 });
		const reportPromise = engine.run(plan([task("a"), task("b")], [worker("w1"), worker("w2")]));
		await waitFor(() => runner.starts.length === 2);

		// Cancel w1 (running task a) while w2 keeps running task b.
		expect(engine.cancelWorker("w1", "stuck worker")).toBe(true);
		expect(engine.cancelWorker("nonexistent")).toBe(false);

		// Dynamically add task c depending on b.
		engine.addTask(task("c", ["b"]));
		runner.finish("b");

		await waitFor(() => runner.starts.some(s => s.taskId === "c"));
		runner.finish("c");

		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("cancelled");
		expect(report.outcomes.get("b")?.state).toBe("completed");
		expect(report.outcomes.get("c")?.state).toBe("completed");
		expect(report.stoppedReason).toBeUndefined();
	});

	test("integrates an isolated upstream dependency before starting its dependent and orders remaining branches topologically", async () => {
		const order: string[] = [];
		const integrator: Integrator = {
			async integrate(pending: readonly PendingIntegration[]): Promise<IntegrationReport> {
				for (const entry of pending) {
					order.push(`integrate:${entry.taskId}`);
				}
				return { merged: pending.map(p => p.branchName), failed: [] };
			},
		};
		const runner: EngineRunner = {
			async run(_spec, t): Promise<WorkerOutcome> {
				order.push(`run:${t.id}`);
				return {
					exitCode: 0,
					output: `${t.id} ok`,
					changes: { branchName: `branch-${t.id}`, hasChanges: true },
				};
			},
		};
		const engine = new OrchestrationEngine({ runner, concurrency: 1, integrator });
		const report = await engine.run(
			plan([task("b", ["a"], ["src/b.ts"]), task("a", [], ["src/a.ts"])], [worker("w1", true)]),
		);
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("completed");
		// Task a must run and integrate before task b runs; then task b integrates.
		expect(order).toEqual(["run:a", "integrate:a", "run:b", "integrate:b"]);
	});

	test("isolates listener exceptions in #emit so a throwing subscriber cannot deadlock the run", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 1 });
		engine.subscribe(() => {
			throw new Error("boom in listener");
		});
		const reportPromise = engine.run(plan([task("a")]));
		await waitFor(() => runner.starts.length === 1);
		runner.finish("a");
		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("completed");
	});

	test("worker messages ride the injected transport and land in the log", async () => {
		const transport = new InMemoryMessageTransport();
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, transport });
		const events: OrchestratorEvent[] = [];
		engine.subscribe(event => events.push(event));
		const reportPromise = engine.run(
			plan([task("a", [], ["packages/a/x.ts"]), task("b", [], ["packages/b/y.ts"])], [worker("w1"), worker("w2")]),
		);
		await waitFor(() => runner.starts.length === 2);

		await runner.contextFor("a").sendMessage({ to: "w2", kind: "handoff", body: "interfaces are ready" });
		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]?.body).toBe("interfaces are ready");
		expect(
			engine.messages.map(message => ({
				from: message.from,
				to: message.to,
				kind: message.kind,
				status: message.status,
			})),
		).toEqual([{ from: "w1", to: "w2", kind: "handoff", status: "delivered" }]);
		expect(events.some(event => event.type === "message")).toBe(true);

		runner.finish("a");
		runner.finish("b");
		const report = await reportPromise;
		expect(report.messages).toHaveLength(1);
	});

	test("a failed delivery is recorded as failed, not silently dropped", async () => {
		const transport = new InMemoryMessageTransport();
		transport.failingRecipients.add("w2");
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, transport });
		const reportPromise = engine.run(
			plan([task("a", [], ["packages/a/x.ts"]), task("b", [], ["packages/b/y.ts"])], [worker("w1"), worker("w2")]),
		);
		await waitFor(() => runner.starts.length === 2);
		await runner.contextFor("a").sendMessage({ to: "w2", kind: "query", body: "schemas?" });
		expect(engine.messages[0]?.status).toBe("failed");

		runner.finish("a");
		runner.finish("b");
		await reportPromise;
	});

	test("start order is deterministic for the same plan", async () => {
		const runs: string[][] = [];
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const runner = new FakeRunner();
			const engine = new OrchestrationEngine({ runner, concurrency: 2 });
			const reportPromise = engine.run(plan([task("a"), task("b"), task("c", ["a"])]));
			await waitFor(() => runner.starts.length === 2);
			runner.finish("a");
			await waitFor(() => runner.starts.length === 3);
			runner.finish("b");
			runner.finish("c");
			await reportPromise;
			runs.push(runner.starts.map(start => start.taskId));
		}
		expect(runs[0]).toEqual(["a", "b", "c"]);
		expect(runs[1]).toEqual(runs[0]);
	});

	test("emits lifecycle events for tasks and workers with workerId on task_state", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 1 });
		const events: OrchestratorEvent[] = [];
		engine.subscribe(event => events.push(event));
		const reportPromise = engine.run(plan([task("a", [], ["packages/a/x.ts"])]));
		await waitFor(() => runner.starts.length === 1);
		runner.finish("a");
		await reportPromise;
		const kinds = events.map(event => event.type);
		expect(kinds).toContain("plan_started");
		expect(kinds).toContain("task_state");
		expect(kinds).toContain("worker_state");
		expect(kinds).toContain("leases_granted");
		expect(kinds).toContain("plan_finished");
		const runningTaskEvent = events.find(e => e.type === "task_state" && e.to === "running");
		expect(runningTaskEvent && runningTaskEvent.type === "task_state" ? runningTaskEvent.workerId : undefined).toBe(
			"w1",
		);
	});
});
