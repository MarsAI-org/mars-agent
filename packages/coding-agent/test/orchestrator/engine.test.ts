/**
 * Engine contracts (all runs use a fake runner; no test reaches a model):
 * - independent tasks start concurrently up to the cap, dependents wait
 * - scheduling order is deterministic for the same plan
 * - overlapping write leases serialize the workers instead of corrupting files
 * - global stop cancels pending work and aborts running workers
 * - budget exhaustion stops the run before new workers start
 * - typed worker messages flow through the injected transport
 */

import { describe, expect, test } from "bun:test";
import { OrchestrationEngine, type EngineRunner, type WorkerRunContext } from "../../src/orchestrator/engine";
import { InMemoryMessageTransport } from "../../src/orchestrator/message-bus";
import type { OrchestratorEvent, OrchestratorPlan, WorkerOutcome, WorkerSpec } from "../../src/orchestrator/types";

interface Start {
	readonly spec: WorkerSpec;
	readonly taskId: string;
}

class FakeRunner implements EngineRunner {
	readonly starts: Start[] = [];
	readonly gates = new Map<string, PromiseWithResolvers<WorkerOutcome>>();
	readonly contexts = new Map<string, WorkerRunContext>();
	/** Usage the runner reports for a task when it finishes. */
	usage = new Map<string, { totalTokens: number; requests: number }>();
	abortReasons: string[] = [];

	async run(spec: WorkerSpec, task: { id: string }, context: WorkerRunContext): Promise<WorkerOutcome> {
		this.starts.push({ spec, taskId: task.id });
		this.contexts.set(task.id, context);
		const gate = Promise.withResolvers<WorkerOutcome>();
		this.gates.set(task.id, gate);
		context.signal.addEventListener("abort", () => {
			this.abortReasons.push(String(context.signal.reason));
			gate.resolve({ exitCode: 1, output: "", error: "aborted" });
		});
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

function worker(id: string): WorkerSpec {
	return { id, roleLabel: id, backend: "native", isolated: false };
}

function plan(
	tasks: readonly OrchestratorPlan["tasks"][number][],
	workers: readonly WorkerSpec[] = [worker("w1")],
): OrchestratorPlan {
	return { id: "plan-1", goal: "test", tasks, workers };
}

function task(
	id: string,
	dependencies: readonly string[] = [],
	targetFiles: readonly string[] = [],
): OrchestratorPlan["tasks"][number] {
	return { id, title: id, description: `do ${id}`, dependencies, targetFiles };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

describe("OrchestrationEngine", () => {
	test("runs independent tasks concurrently and reports outcomes", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 2 });
		const reportPromise = engine.run(plan([task("a", [], ["packages/a/x.ts"]), task("b", [], ["packages/b/y.ts"])]));
		await waitFor(() => runner.starts.length === 2);
		expect(runner.starts.map(start => start.taskId)).toEqual(["a", "b"]);
		expect(runner.starts.every(start => start.spec.id === "w1")).toBe(true);

		runner.finish("a");
		runner.finish("b");
		const report = await reportPromise;
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("completed");
		expect(report.stoppedReason).toBeUndefined();
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
			plan([task("a", [], ["src/shared.ts"]), task("b", [], ["src/shared.ts"])], [worker("w1"), worker("w2")]),
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

	test("global stop cancels pending tasks and aborts running workers", async () => {
		const runner = new FakeRunner();
		const engine = new OrchestrationEngine({ runner, concurrency: 1 });
		const reportPromise = engine.run(plan([task("a"), task("b")]));
		await waitFor(() => runner.starts.length === 1);

		engine.stopAll("user requested stop");
		await waitFor(() => runner.abortReasons.length === 1);
		const report = await reportPromise;
		expect(report.stoppedReason).toBe("user requested stop");
		expect(report.outcomes.get("a")?.state).toBe("failed"); // aborted run reports failure
		expect(report.outcomes.get("b")?.state).toBe("cancelled");
		expect(runner.abortReasons[0]).toContain("user requested stop");
	});

	test("token budget exhaustion stops the run before new workers start", async () => {
		const runner = new FakeRunner();
		runner.usage.set("a", { totalTokens: 1200, requests: 2 });
		const engine = new OrchestrationEngine({ runner, concurrency: 1, budget: { maxTokens: 1000 } });
		const events: OrchestratorEvent[] = [];
		engine.subscribe(event => events.push(event));
		const reportPromise = engine.run(plan([task("a"), task("b"), task("c")]));
		await waitFor(() => runner.starts.length === 1);

		runner.finish("a");
		const report = await reportPromise;
		expect(report.stoppedReason).toContain("token budget exceeded");
		expect(report.outcomes.get("a")?.state).toBe("completed");
		expect(report.outcomes.get("b")?.state).toBe("cancelled");
		expect(report.usage.totalTokens).toBe(1200);
		expect(events.some(event => event.type === "budget_exhausted")).toBe(true);
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
		// The in-memory transport carries the typed message as-is; the bracketed
		// kind prefix is encoded only when crossing the real peer bus
		// (see IrcMessageTransport and the message-bus encoding tests).
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

	test("emits lifecycle events for tasks and workers", async () => {
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
	});
});
