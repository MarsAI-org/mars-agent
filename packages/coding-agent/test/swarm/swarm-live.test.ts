import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@marsai-org/agent-core";
import { AuthStorage } from "@marsai-org/coding-agent/session/auth-storage";
import { parseIsolationBackend } from "@marsai-org/coding-agent/task/worktree";
import { ModelRegistry } from "@marsai-org/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@marsai-org/coding-agent/config/settings";
import { executeBuiltinSlashCommand } from "@marsai-org/coding-agent/slash-commands/builtin-registry";
import {
	loadSwarmBoardJsonl,
	messageMentionsMember,
	parseBoardMentions,
	SwarmBoard,
} from "@marsai-org/coding-agent/swarm/board";
import {
	clearActiveSwarmSession,
	getActiveSwarmSession,
	setActiveSwarmSession,
	SWARM_COORDINATOR_READ_ONLY_TOOLS,
	SWARM_OPEN_BOARD_HINT,
	SwarmSessionRuntime,
	type SwarmWorkerHandle,
	type SwarmWorkerSpawnParams,
	validateSwarmWorkerName,
} from "@marsai-org/coding-agent/swarm/runtime";
import { createSwarmCoordinatorTools } from "@marsai-org/coding-agent/swarm/tools";

afterEach(async () => {
	const active = getActiveSwarmSession();
	if (active) {
		await active.dispose();
	}
	clearActiveSwarmSession();
	resetSettingsForTest();
	vi.restoreAllMocks();
});

async function createTestRegistry(): Promise<{
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}> {
	const settings = Settings.isolated({});
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	return { settings, authStorage, modelRegistry };
}

describe("SwarmBoard", () => {
	it("parses @mentions, persists JSONL, and supports since/limit/seqs reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-swarm-board-test-"));
		try {
			const board = new SwarmBoard({
				swarmId: "swarm-test-1",
				baseDir: tempDir,
				now: () => new Date("2026-11-25T07:30:00Z"),
			});

			const m1 = board.post("coordinator", "@worker-1 implement parser and hand off to @verifier");
			const m2 = board.post("worker-1", "@verifier parser done, please test");
			const m3 = board.post("verifier", "@coordinator [done] all tests pass");
			await board.flush();

			expect(m1.seq).toBe(1);
			expect(m1.mentions).toEqual(["worker-1", "verifier"]);
			expect(messageMentionsMember(m1, "worker-1")).toBe(true);
			expect(messageMentionsMember(m1, "coordinator")).toBe(false);
			expect(parseBoardMentions("ping @All and @Worker-1 and @worker-1")).toEqual(["all", "worker-1"]);

			// Group prefix match: `@worker` wakes `worker-1`
			const m4 = board.post("coordinator", "@worker check formatting");
			expect(messageMentionsMember(m4, "worker-1")).toBe(true);
			expect(messageMentionsMember(m4, "verifier")).toBe(false);

			expect(board.read({ since: 1, limit: 2 }).messages.map(m => m.seq)).toEqual([2, 3]);
			expect(board.read({ seqs: [1, 3, 99] }).messages.map(m => m.seq)).toEqual([1, 3]);
			expect(board.read().head).toBe(4);
			expect(m2.seq).toBe(2);
			expect(m3.seq).toBe(3);

			await board.flush();
			expect(board.filePath).toBeDefined();
			const reloaded = await loadSwarmBoardJsonl(board.filePath!);
			expect(reloaded.map(m => m.seq)).toEqual([1, 2, 3, 4]);
			expect(reloaded[2]?.text).toContain("[done]");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("wakes waitForPost reactively on matching @mention and resolves immediately for missed posts", async () => {
		const board = new SwarmBoard({ swarmId: "swarm-wait-test", persist: false });
		board.post("coordinator", "@parser start work");

		const waiting = board.waitForPost({ member: "coordinator", since: 1, mentionsOnly: true, timeoutMs: 5000 });

		// Unmentioned message does not wake coordinator.
		board.post("parser", "interim note without mention");
		// Mentioning coordinator wakes immediately with ALL messages after seq 1.
		board.post("parser", "@coordinator [done] parser landed");

		const result = await waiting;
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
		expect(result.head).toBe(3);
		expect(result.messages.map(m => m.seq)).toEqual([2, 3]);

		// Calling waitForPost with stale `since: 1` resolves immediately without sleeping.
		const immediate = await board.waitForPost({
			member: "coordinator",
			since: 1,
			mentionsOnly: true,
			timeoutMs: 5000,
		});
		expect(immediate.messages.map(m => m.seq)).toEqual([2, 3]);
	});
});

describe("SwarmSessionRuntime & Tools", () => {
	it("validates worker names, spawns persistent multi-turn workers, wakes them on @mention, and cleans up on kill", async () => {
		expect(validateSwarmWorkerName("parser")).toBeUndefined();
		expect(validateSwarmWorkerName("all")).toContain("reserved");
		expect(validateSwarmWorkerName("coordinator")).toContain("reserved");
		expect(validateSwarmWorkerName("coordinator-1")).toContain("reserved");
		expect(validateSwarmWorkerName("BadName")).toContain("Invalid worker name");

		const { settings, authStorage, modelRegistry } = await createTestRegistry();
		const promptsByWorker = new Map<string, string[]>();
		const workerToolsSeen = new Map<string, string[]>();
		const disposedWorkers: string[] = [];
		const cleanedWorktrees: string[] = [];
		const turnResolvers = new Map<string, Array<() => void>>();

		const workerFactory = async (params: SwarmWorkerSpawnParams): Promise<SwarmWorkerHandle> => {
			workerToolsSeen.set(
				params.name,
				params.swarmTools.map(t => t.name),
			);
			return {
				prompt: async text => {
					const list = promptsByWorker.get(params.name) ?? [];
					list.push(text);
					promptsByWorker.set(params.name, list);
					// First turn: post a handoff to coordinator
					if (list.length === 1) {
						params.runtime.board.post(params.name, `@coordinator [done] finished turn 1 in ${params.cwd}`);
					} else {
						params.runtime.board.post(params.name, `@coordinator [done] finished turn ${list.length}`);
					}
					const waiters = turnResolvers.get(params.name);
					if (waiters) {
						for (const r of waiters.splice(0)) r();
					}
				},
				abort: async () => {},
				dispose: async () => {
					disposedWorkers.push(params.name);
				},
				getModelLabel: () => "volt/test-model",
				getEnabledToolNames: () => ["read", "write", "edit", "bash", "post_message", "read_board", "swarm_wait"],
			};
		};

		const runtime = new SwarmSessionRuntime({
			swarmId: "swarm-runtime-test",
			cwd: "/tmp/repo",
			settings,
			authStorage,
			modelRegistry,
			persistBoard: false,
			workerFactory,
			isolationProvider: {
				ensure: async (_cwd, id) => ({
					mergedDir: `/tmp/wt/${id}`,
					backend: parseIsolationBackend("rcopy")!,
					fellBack: false,
					fallbackReason: null,
				}),
				cleanup: async handle => {
					cleanedWorktrees.push(handle.mergedDir);
				},
			},
		});

		const tools = createSwarmCoordinatorTools(runtime);
		const byName = new Map<string, AgentTool>(tools.map(t => [t.name, t]));
		const swarmTool = byName.get("swarm")!;
		const postTool = byName.get("post_message")!;
		const waitTool = byName.get("swarm_wait")!;

		// 1. Set title
		const titleRes = await swarmTool.execute("c1", { action: "title", title: "Refactor Parser" } as never);
		expect((titleRes.details as { title: string }).title).toBe("Refactor Parser");

		// 2. Spawn sharded workers with tasks[] + isolated worktree
		const addRes = await swarmTool.execute("c2", {
			action: "add",
			name: "impl",
			brief: "Implement slice cleanly.",
			tasks: ["src/a.ts", "src/b.ts"],
			workspace: "worktree",
		} as never);
		const addDetails = addRes.details as { added: string[]; open_board: string };
		expect(addDetails.added).toEqual(["impl-1", "impl-2"]);
		expect(addDetails.open_board).toBe(SWARM_OPEN_BOARD_HINT);
		expect(workerToolsSeen.get("impl-1")).toEqual(["post_message", "read_board", "swarm_wait"]);

		// 3. Coordinator waits reactively via swarm_wait
		const waitRes = await waitTool.execute("c3", { since: 0, mentions_only: true } as never);
		const waitDetails = waitRes.details as { messages: Array<{ agent: string; text: string }> };
		expect(
			waitDetails.messages.some(m => m.agent === "impl-1" && m.text.includes("/tmp/wt/swarm-runtime-test-impl-1")),
		).toBe(true);

		// Wait briefly for impl-1 to settle back into waiting state before second wakeup
		await Bun.sleep(10);
		const wakeDone = Promise.withResolvers<void>();
		turnResolvers.set("impl-1", [wakeDone.resolve]);

		// 4. Follow-up @mention wakes SAME persistent worker session for turn 2
		await postTool.execute("c4", { text: "@impl-1 please also update tests" } as never);
		await wakeDone.promise;
		expect(promptsByWorker.get("impl-1")?.length).toBe(2);

		// 5. Status reports members and open_board hint
		const statusRes = await swarmTool.execute("c5", { action: "status" } as never);
		const statusDetails = statusRes.details as { open_board: string; members: Array<{ name: string }> };
		expect(statusDetails.open_board).toBe(SWARM_OPEN_BOARD_HINT);
		expect(statusDetails.members.map(m => m.name)).toEqual(["coordinator", "impl-1", "impl-2"]);

		// 6. Kill cleans up worker session + worktree
		const killRes = await swarmTool.execute("c6", { action: "kill", name: "impl-1" } as never);
		expect((killRes.details as { killed: string }).killed).toBe("impl-1");
		expect(disposedWorkers).toContain("impl-1");
		expect(cleanedWorktrees).toContain("/tmp/wt/swarm-runtime-test-impl-1");

		await runtime.dispose();
		expect(disposedWorkers).toContain("impl-2");
		expect(cleanedWorktrees).toContain("/tmp/wt/swarm-runtime-test-impl-2");
	});
});

describe("/swarm <prompt> slash command & Coordinator tool gating", () => {
	it("activates Coordinator Mode (read-only + 4 swarm tools, NO write/edit/bash) and submits free-text prompt", async () => {
		const { settings, authStorage, modelRegistry } = await createTestRegistry();
		let activeTools = ["read", "grep", "glob", "write", "edit", "bash", "eval"];
		let coordinatorState: { enabled: boolean; swarmId: string } | undefined;

		let runtime: SwarmSessionRuntime | undefined;
		let previousTools: string[] | undefined;

		const enterSwarmCoordinatorMode = vi.fn(async () => {
			previousTools = [...activeTools];
			runtime = new SwarmSessionRuntime({
				swarmId: "swarm-slash-test",
				cwd: "/tmp/repo",
				settings,
				authStorage,
				modelRegistry,
				persistBoard: false,
			});
			setActiveSwarmSession(runtime);
			const swarmTools = createSwarmCoordinatorTools(runtime);
			activeTools = [...SWARM_COORDINATOR_READ_ONLY_TOOLS, ...swarmTools.map(t => t.name)];
			coordinatorState = { enabled: true, swarmId: runtime.swarmId };
			return runtime;
		});

		const exitSwarmCoordinatorMode = vi.fn(async () => {
			await runtime?.dispose();
			activeTools = previousTools ?? activeTools;
			coordinatorState = undefined;
		});

		const openSwarmBoard = vi.fn(() => true);
		const showStatus = vi.fn();
		const ctx = {
			settings,
			session: {
				getEnabledToolNames: () => [...activeTools],
				setActiveToolsByName: async (names: string[]) => {
					activeTools = [...names];
				},
				hasBuiltInTool: (name: string) => ["read", "grep", "glob", "write", "edit", "bash", "eval"].includes(name),
			},
			enterSwarmCoordinatorMode,
			exitSwarmCoordinatorMode,
			openSwarmBoard,
			editor: { setText: vi.fn(), clearDraft: vi.fn() },
			showStatus,
			showError: vi.fn(),
			ui: { requestRender: vi.fn(), showOverlay: vi.fn(), setFocus: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			input: undefined,
		};

		// 1. `/swarm <free-text prompt>` activates Coordinator Mode and returns `{ prompt }` to submit
		const promptResult = await executeBuiltinSlashCommand("/swarm refactor parser and add comprehensive unit tests", {
			ctx,
		} as never);
		expect(promptResult).toBe("refactor parser and add comprehensive unit tests");
		expect(enterSwarmCoordinatorMode).toHaveBeenCalledTimes(1);
		expect(coordinatorState?.enabled).toBe(true);
		// Coordinator MUST have read-only + 4 swarm tools, and MUST NOT have write/edit/bash/eval!
		expect(activeTools).toEqual(["read", "grep", "glob", "swarm", "post_message", "read_board", "swarm_wait"]);
		expect(activeTools).not.toContain("write");
		expect(activeTools).not.toContain("edit");
		expect(activeTools).not.toContain("bash");
		expect(activeTools).not.toContain("eval");

		// 2. `/swarm status` reports live swarm roster + Alt+S hint
		const statusHandled = await executeBuiltinSlashCommand("/swarm status", { ctx } as never);
		expect(statusHandled).toBe(true);
		expect(String(showStatus.mock.calls.at(-1)?.[0] ?? "")).toContain(SWARM_OPEN_BOARD_HINT);

		// 3. `/swarm board` opens SwarmBoardComponent via openSwarmBoard
		const boardHandled = await executeBuiltinSlashCommand("/swarm board", { ctx } as never);
		expect(boardHandled).toBe(true);
		expect(openSwarmBoard).toHaveBeenCalledTimes(1);

		// 4. `/swarm off` disposes swarm and restores original toolset (including write/edit/bash/eval)
		const offHandled = await executeBuiltinSlashCommand("/swarm off", { ctx } as never);
		expect(offHandled).toBe(true);
		expect(exitSwarmCoordinatorMode).toHaveBeenCalledTimes(1);
		expect(activeTools).toEqual(["read", "grep", "glob", "write", "edit", "bash", "eval"]);
		expect(getActiveSwarmSession()).toBeUndefined();
	});

	it("validates addWorkers n/model, rolls back partial batches, and enforces switchWorkerModel rules", async () => {
		const { settings, authStorage, modelRegistry } = await createTestRegistry();
		const models = modelRegistry.getAll();
		const firstModel = models[0]!;
		const secondModel = models.find(m => m.id !== firstModel.id) ?? firstModel;

		const disposeCalls: string[] = [];
		let failOnSecond = false;
		const workerTurnGate = Promise.withResolvers<void>();
		let setModelCalls = 0;

		const runtime = new SwarmSessionRuntime({
			cwd: process.cwd(),
			settings,
			authStorage,
			modelRegistry,
			coordinatorModel: firstModel,
			persistBoard: false,
			workerFactory: async (params: SwarmWorkerSpawnParams): Promise<SwarmWorkerHandle> => {
				if (failOnSecond && params.name === "shard-2") {
					throw new Error("boom during spawn");
				}
				return {
					prompt: async () => {
						await workerTurnGate.promise;
					},
					abort: async () => {
						workerTurnGate.resolve();
					},
					setModel: async () => {
						setModelCalls += 1;
					},
					dispose: async () => {
						disposeCalls.push(params.name);
					},
				};
			},
		});

		await expect(runtime.addWorkers({ name: "bad", brief: "test", n: 0 })).rejects.toThrow(/integer between 1/);
		await expect(runtime.addWorkers({ name: "bad", brief: "test", n: 1.5 })).rejects.toThrow(/integer between 1/);
		await expect(
			runtime.addWorkers({ name: "bad", brief: "test", model: "definitely-missing-model-xyz" }),
		).rejects.toThrow(/could not be resolved/);

		failOnSecond = true;
		await expect(runtime.addWorkers({ name: "shard", brief: "batch", n: 2 })).rejects.toThrow("boom during spawn");
		expect(disposeCalls).toEqual(["shard-1"]);
		expect(runtime.snapshot().members.filter(m => m.role === "worker" && m.state !== "killed")).toEqual([]);

		failOnSecond = false;
		await runtime.addWorkers({ name: "worker", brief: "do work" });
		// Worker is currently working on its initial assignment
		await expect(runtime.switchWorkerModel("worker", secondModel.id)).rejects.toThrow(/currently working/);

		// Finish turn -> waiting
		workerTurnGate.resolve();
		await Bun.sleep(10);

		await expect(runtime.switchWorkerModel("worker", "definitely-missing-model-xyz")).rejects.toThrow(
			/could not be resolved/,
		);
		const switched = await runtime.switchWorkerModel("worker", secondModel.id);
		expect(switched.name).toBe("worker");
		expect(setModelCalls).toBe(1);

		await runtime.stopAllWorkers();
		expect(runtime.snapshot().members.find(m => m.name === "worker")?.state).toBe("killed");
		await runtime.dispose();
	});

	it("handles waitForPost (mentionsOnly=false, abort, timeout), >50-post pendingWake, and worktree fallback warnings", async () => {
		const { settings, authStorage, modelRegistry } = await createTestRegistry();
		const board = new SwarmBoard({ swarmId: "wait-test", persist: false });

		const ac = new AbortController();
		const abortedWait = board.waitForPost({ member: "worker", since: 0, signal: ac.signal });
		ac.abort();
		expect(await abortedWait).toMatchObject({ aborted: true, timedOut: false });

		const timedOutWait = await board.waitForPost({ member: "worker", since: 0, timeoutMs: 10 });
		expect(timedOutWait).toMatchObject({ timedOut: true, aborted: false });

		const anyWait = board.waitForPost({ member: "worker", since: 0, mentionsOnly: false });
		board.post("coordinator", "unaddressed broadcast");
		const anyRes = await anyWait;
		expect(anyRes.messages).toHaveLength(1);

		const prompts: string[] = [];
		const firstTurnGate = Promise.withResolvers<void>();
		let turnCount = 0;

		const runtime = new SwarmSessionRuntime({
			cwd: process.cwd(),
			settings,
			authStorage,
			modelRegistry,
			persistBoard: false,
			isolationProvider: {
				ensure: async () => {
					throw new Error("overlay unavailable");
				},
				cleanup: async () => {},
			},
			workerFactory: async (): Promise<SwarmWorkerHandle> => ({
				prompt: async text => {
					turnCount += 1;
					prompts.push(text);
					if (turnCount === 1) {
						await firstTurnGate.promise;
					}
				},
				abort: async () => {
					firstTurnGate.resolve();
				},
				dispose: async () => {},
			}),
		});

		const added = await runtime.addWorkers({ name: "alpha", brief: "start", workspace: "worktree" });
		expect(added.warnings[0]).toContain("worktree isolation unavailable (overlay unavailable)");

		// Post 55 unrelated messages + 1 mention while worker is busy in turn 1
		for (let i = 0; i < 55; i++) {
			runtime.board.post("coordinator", `noise ${i}`);
		}
		runtime.board.post("coordinator", "@alpha follow-up after 55 posts");

		firstTurnGate.resolve();
		await Bun.sleep(20);
		expect(prompts.length).toBe(2);
		expect(prompts[1]).toContain("@alpha follow-up after 55 posts");
		await runtime.dispose();
	});
});
