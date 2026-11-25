/**
 * Native AgentTools for Mars live Swarm sessions:
 * - `swarm`: title, add, status, model, kill (coordinator tool)
 * - `post_message`: post to the shared numbered board (coordinator + workers)
 * - `read_board`: read messages by `since`, `limit`, or `seqs` (coordinator + workers)
 * - `swarm_wait`: event-driven sleep until a matching post arrives (coordinator + workers)
 */

import type { AgentTool, AgentToolResult } from "@marsai-org/agent-core";
import { type } from "@marsai-org/omptype";
import { SWARM_OPEN_BOARD_HINT, type SwarmSessionRuntime } from "./runtime";

const swarmToolSchema = type({
	action: type("'title' | 'add' | 'status' | 'model' | 'kill'").describe(
		"Swarm action: title (name the swarm), add (spawn worker(s)), status (inspect roster), model (switch waiting worker's model), or kill (terminate worker)",
	),
	"title?": type("string").describe("Short title for the swarm (for action: 'title')"),
	"name?": type("string").describe(
		"Lowercase worker name (or base name when n/tasks is set), e.g. 'parser' or 'verifier' (for add/model/kill)",
	),
	"brief?": type("string").describe(
		"Self-contained assignment for the worker: what it owns, what not to touch, and what done looks like (for action: 'add')",
	),
	"model?": type("string").describe("Optional model selector override (for add/model)"),
	"workspace?": type("'inherit' | 'worktree'").describe(
		"Where the worker runs: 'inherit' (shared repo checkout, default) or 'worktree' (isolated checkout cleaned up on kill)",
	),
	"n?": type("number").describe("Optional count of homogeneous copies (<name>-1..<name>-<n>) for action: 'add'"),
	"tasks?": type("string")
		.array()
		.describe("Optional per-worker slice targets (<name>-1..<name>-<k>) combined with brief for action: 'add'"),
});

const postMessageSchema = type({
	text: type("string").describe("Message text to post on the shared swarm board (use @name or @all to wake peers)"),
});

const readBoardSchema = type({
	"since?": type("number").describe("Return oldest messages strictly after this sequence number"),
	"limit?": type("number").describe("Maximum messages to return (default 20)"),
	"seqs?": type("number")
		.array()
		.describe("Return only these exact message sequence numbers (ignores since and limit)"),
});

const swarmWaitSchema = type({
	since: type("number").describe(
		"Highest sequence number you have already seen; wakes immediately if a matching message already exists after this seq",
	),
	"mentions_only?": type("boolean").describe(
		"Wake only when a message mentions your name or @all (default true). Pass false to wake on any post.",
	),
});

function jsonResult(payload: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

function errorResult(message: string): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { error: message },
	};
}

export function createSwarmTool(runtime: SwarmSessionRuntime, callerName: string): AgentTool<typeof swarmToolSchema> {
	return {
		name: "swarm",
		label: "Swarm",
		summary: "Manage live swarm workers (title, add, status, model, kill)",
		description:
			"Manage the live swarm of persistent workers on the shared message board. Actions: 'title' names the swarm; 'add' spawns named worker(s) and posts their brief as @<name>; 'status' lists all members, states, models, and board head; 'model' switches a waiting worker's model; 'kill' permanently ends a worker and cleans up its worktree.",
		parameters: swarmToolSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params) {
			try {
				switch (params.action) {
					case "title": {
						if (!params.title?.trim()) {
							return errorResult('Action "title" requires a non-empty "title".');
						}
						const title = runtime.setTitle(params.title);
						return jsonResult({ title, swarmId: runtime.swarmId });
					}
					case "add": {
						if (!params.name?.trim()) {
							return errorResult('Action "add" requires "name".');
						}
						if (!params.brief?.trim()) {
							return errorResult('Action "add" requires "brief".');
						}
						const result = await runtime.addWorkers({
							name: params.name,
							brief: params.brief,
							model: params.model,
							workspace: params.workspace,
							n: params.n,
							tasks: params.tasks,
							addedBy: callerName,
						});
						return jsonResult({
							added: result.added,
							seqs: result.seqs,
							head: runtime.board.head,
							...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
							open_board: SWARM_OPEN_BOARD_HINT,
						});
					}
					case "status": {
						const snap = runtime.snapshot();
						return jsonResult({
							swarmId: snap.swarmId,
							title: snap.title,
							head: runtime.board.head,
							members: snap.members.map(m => ({
								name: m.name,
								role: m.role,
								state: m.state,
								model: m.model,
								workspace: m.workspace,
								...(m.currentActivity ? { currentActivity: m.currentActivity } : {}),
								...(m.lastPostSeq !== undefined ? { lastPostSeq: m.lastPostSeq } : {}),
								...(m.tokens !== undefined ? { tokens: m.tokens } : {}),
							})),
							open_board: SWARM_OPEN_BOARD_HINT,
						});
					}
					case "model": {
						if (!params.name?.trim() || !params.model?.trim()) {
							return errorResult('Action "model" requires both "name" and "model".');
						}
						const switched = await runtime.switchWorkerModel(params.name, params.model);
						return jsonResult(switched);
					}
					case "kill": {
						if (!params.name?.trim()) {
							return errorResult('Action "kill" requires "name".');
						}
						const killed = await runtime.killWorker(params.name);
						if (!killed) {
							return errorResult(`Worker "${params.name}" not found.`);
						}
						return jsonResult({ killed: params.name.trim().toLowerCase() });
					}
				}
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	};
}

export function createPostMessageTool(
	runtime: SwarmSessionRuntime,
	callerName: string,
): AgentTool<typeof postMessageSchema> {
	return {
		name: "post_message",
		label: "Post Message",
		summary: "Post a message to the shared swarm message board",
		description:
			"Post a message to the shared swarm board tagged with your agent name. Include @<name> or @all to wake waiting members.",
		parameters: postMessageSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params) {
			const text = params.text.trim();
			if (!text) {
				return errorResult("Message text cannot be empty.");
			}
			const posted = runtime.board.post(callerName, text);
			return jsonResult({
				status: "posted",
				seq: posted.seq,
				mentions: posted.mentions,
				head: runtime.board.head,
			});
		},
	};
}

export function createReadBoardTool(runtime: SwarmSessionRuntime): AgentTool<typeof readBoardSchema> {
	return {
		name: "read_board",
		label: "Read Board",
		summary: "Read messages from the shared swarm message board",
		description:
			"Read messages from the shared swarm message board (oldest first). Pass `since` to read only newer messages or `seqs` to fetch specific message numbers.",
		parameters: readBoardSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params) {
			const result = runtime.board.read({
				since: params.since,
				limit: params.limit,
				seqs: params.seqs,
			});
			return jsonResult({
				messages: result.messages,
				head: result.head,
			});
		},
	};
}

export function createSwarmWaitTool(
	runtime: SwarmSessionRuntime,
	callerName: string,
): AgentTool<typeof swarmWaitSchema> {
	return {
		name: "swarm_wait",
		label: "Swarm Wait",
		summary: "Wait for the next matching post on the shared swarm message board",
		description:
			"Sleep until a matching message is posted after `since` (zero polling). Returns all missed messages since `since` plus the board head.",
		parameters: swarmWaitSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params, signal) {
			if (callerName === "coordinator") {
				runtime.setCoordinatorState("waiting", `Waiting for board posts after #${params.since}`);
			}
			try {
				const result = await runtime.board.waitForPost({
					member: callerName,
					since: params.since,
					mentionsOnly: params.mentions_only ?? true,
					signal,
				});
				return jsonResult({
					messages: result.messages,
					head: result.head,
					timedOut: result.timedOut,
					aborted: result.aborted,
				});
			} finally {
				if (callerName === "coordinator") {
					runtime.setCoordinatorState("working", "Coordinating swarm");
				}
			}
		},
	};
}

/** Toolset installed on the Coordinator (alongside read-only lookup tools). */
export function createSwarmCoordinatorTools(runtime: SwarmSessionRuntime): AgentTool[] {
	return [
		createSwarmTool(runtime, "coordinator"),
		createPostMessageTool(runtime, "coordinator"),
		createReadBoardTool(runtime),
		createSwarmWaitTool(runtime, "coordinator"),
	];
}

/** Toolset installed on each Worker (alongside its full coding toolset). */
export function createSwarmWorkerTools(runtime: SwarmSessionRuntime, workerName: string): AgentTool[] {
	return [
		createPostMessageTool(runtime, workerName),
		createReadBoardTool(runtime),
		createSwarmWaitTool(runtime, workerName),
	];
}
