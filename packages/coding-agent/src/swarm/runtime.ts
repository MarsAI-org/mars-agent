/**
 * Live Antigravity-style Swarm Session Runtime.
 *
 * Owns:
 * - Swarm identity (`swarmId`, `title`) and shared {@link SwarmBoard}.
 * - Persistent multi-turn worker sessions (each backed by a real Mars
 *   `AgentSession` with full coding tools + swarm messaging tools, and optional
 *   isolated worktree checkout via `ensureIsolation` / `cleanupIsolation`).
 * - Event-driven reactive wakeup loop: workers automatically wake and run a
 *   follow-up turn on the SAME persistent `AgentSession` whenever a board post
 *   mentions `@<name>`, `@<groupPrefix>`, or `@all`.
 * - Live snapshot projection matching `SwarmBoardSnapshot` for `/swarm board`
 *   and `Alt+S`.
 */

import type { AgentTool } from "@marsai-org/agent-core";
import type { Model } from "@marsai-org/ai";
import type {
	SwarmBoardMemberSnapshot,
	SwarmBoardMessageSnapshot,
	SwarmBoardSnapshot,
	SwarmMemberState,
} from "@marsai-org/tui/apps/swarm-board";
import { logger, prompt } from "@marsai-org/utils";
import type { AuthStorage } from "../session/auth-storage";
import type { ModelRegistry } from "../config/model-registry";
import { resolveCliModel } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import swarmWorkerPromptTemplate from "../prompts/system/swarm-worker.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { cleanupIsolation, ensureIsolation, type IsolationHandle } from "../task/worktree";
import { messageMentionsMember, SwarmBoard, type SwarmBoardMessage } from "./board";
import { createSwarmWorkerTools } from "./tools";

export type { SwarmBoardMemberSnapshot, SwarmBoardMessageSnapshot, SwarmBoardSnapshot, SwarmMemberState };

export interface SwarmWorkerHandle {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	setModel?(model: Model): Promise<void>;
	subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
	getModelLabel?(): string;
	getEnabledToolNames?(): string[];
}

export interface SwarmWorkerSpawnParams {
	readonly name: string;
	readonly cwd: string;
	readonly workspace: "inherit" | "worktree";
	readonly model?: Model;
	readonly modelPattern?: string;
	readonly systemPrompt: string;
	readonly swarmTools: AgentTool[];
	readonly runtime: SwarmSessionRuntime;
}

export type SwarmWorkerFactory = (params: SwarmWorkerSpawnParams) => Promise<SwarmWorkerHandle>;

export interface SwarmSessionRuntimeOptions {
	readonly swarmId?: string;
	readonly title?: string;
	readonly cwd: string;
	readonly settings: Settings;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly coordinatorModel?: Model;
	readonly boardBaseDir?: string;
	readonly persistBoard?: boolean;
	/** Injectable worker session factory for deterministic unit tests (defaults to real `createAgentSession`). */
	readonly workerFactory?: SwarmWorkerFactory;
	/** Injectable isolation creator/cleanup for unit tests. */
	readonly isolationProvider?: {
		ensure(baseCwd: string, id: string): Promise<IsolationHandle>;
		cleanup(handle: IsolationHandle): Promise<void>;
	};
}

export interface SwarmAddWorkerOptions {
	readonly name: string;
	readonly brief: string;
	readonly model?: string;
	readonly workspace?: "inherit" | "worktree";
	readonly n?: number;
	readonly tasks?: readonly string[];
	readonly addedBy?: string;
}

export interface SwarmAddWorkerResult {
	readonly added: readonly string[];
	readonly seqs: readonly number[];
	readonly warnings: readonly string[];
}

interface WorkerRecord {
	readonly name: string;
	readonly role: "coordinator" | "worker";
	state: SwarmMemberState;
	modelLabel: string;
	readonly workspace: "inherit" | "worktree";
	readonly cwd: string;
	currentActivity?: string;
	lastPostSeq?: number;
	lastSeenSeq: number;
	tokens: number;
	readonly outputTail: string[];
	handle?: SwarmWorkerHandle;
	unsubscribeSession?: () => void;
	isolationHandle?: IsolationHandle;
	turnPromise?: Promise<void>;
	pendingWake: boolean;
}

/** Allowed worker roster name: lowercase, starts with letter/digit, up to 24 chars. */
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const OUTPUT_TAIL_CAP = 80;
const OUTPUT_LINE_MAX_CHARS = 240;
const MAX_SHARD_COUNT = 16;

export const SWARM_COORDINATOR_READ_ONLY_TOOLS = ["read", "grep", "glob"] as const;
export const SWARM_OPEN_BOARD_HINT = "Run /swarm board (or press Alt+S) to open the live board.";

/** Validate a single worker roster name against swarm naming rules. */
export function validateSwarmWorkerName(name: string): string | undefined {
	if (!name || !WORKER_NAME_PATTERN.test(name)) {
		return `Invalid worker name "${name}". Must be lowercase [a-z0-9_-], start with a letter or digit, and be at most 24 characters.`;
	}
	if (name === "all" || name === "coordinator" || name.startsWith("coordinator-")) {
		return `Worker name "${name}" is reserved (cannot be "all", "coordinator", or "coordinator-*").`;
	}
	return undefined;
}

function formatModelLabel(model?: Model, fallback?: string): string {
	if (model) return `${model.provider}/${model.id}`;
	return fallback?.trim() || "default";
}

function sanitizeTailLine(raw: string): string {
	const cleaned = raw.replace(/\r/g, "").replace(/\t/g, "   ").trim();
	return cleaned.length > OUTPUT_LINE_MAX_CHARS ? `${cleaned.slice(0, OUTPUT_LINE_MAX_CHARS - 1)}…` : cleaned;
}

function formatBoardMessagesForPrompt(messages: readonly SwarmBoardMessage[]): string {
	return messages.map(msg => `[#${msg.seq} ${msg.agent} ${msg.time}]\n${msg.text}`).join("\n\n");
}

function extractActivityFromEvent(event: AgentSessionEvent): {
	activity?: string;
	outputLine?: string;
	tokens?: number;
} {
	if (event.type === "tool_execution_start") {
		const argsPreview =
			event.args && typeof event.args === "object"
				? Object.values(event.args as Record<string, unknown>)
						.filter(v => typeof v === "string" && v.trim().length > 0)
						.map(v => String(v).trim())
						.slice(0, 1)
						.join("")
				: "";
		const summary = argsPreview ? `${event.toolName}: ${sanitizeTailLine(argsPreview)}` : event.toolName;
		return { activity: summary, outputLine: `→ ${summary}` };
	}
	if (event.type === "tool_execution_end") {
		const mark = event.isError ? "✘" : "✓";
		return { outputLine: `${mark} ${event.toolName}` };
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const usage = event.message.usage;
		const totalTokens = usage?.totalTokens ?? (usage ? usage.input + usage.output : undefined);
		const textParts = event.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text.trim())
			.filter(Boolean);
		const lastLine =
			textParts.length > 0 ? textParts[textParts.length - 1]?.split(/\r?\n/).find(l => l.trim()) : undefined;
		return {
			...(lastLine ? { outputLine: sanitizeTailLine(lastLine) } : {}),
			...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
		};
	}
	return {};
}

export class SwarmSessionRuntime {
	readonly swarmId: string;
	readonly board: SwarmBoard;
	readonly cwd: string;
	readonly #settings: Settings;
	readonly #authStorage: AuthStorage;
	readonly #modelRegistry: ModelRegistry;
	readonly #coordinatorModel?: Model;
	readonly #workerFactory: SwarmWorkerFactory;
	readonly #isolationProvider: {
		ensure(baseCwd: string, id: string): Promise<IsolationHandle>;
		cleanup(handle: IsolationHandle): Promise<void>;
	};
	readonly #members = new Map<string, WorkerRecord>();
	readonly #unsubscribeBoard: () => void;
	#title: string;
	#disposed = false;

	constructor(options: SwarmSessionRuntimeOptions) {
		this.swarmId = options.swarmId ?? `swarm-${Date.now().toString(36)}`;
		this.#title = options.title?.trim() || "Live Swarm";
		this.cwd = options.cwd;
		this.#settings = options.settings;
		this.#authStorage = options.authStorage;
		this.#modelRegistry = options.modelRegistry;
		this.#coordinatorModel = options.coordinatorModel;
		this.board = new SwarmBoard({
			swarmId: this.swarmId,
			baseDir: options.boardBaseDir,
			persist: options.persistBoard ?? true,
		});
		this.#workerFactory = options.workerFactory ?? (params => this.#createRealWorkerSession(params));
		this.#isolationProvider = options.isolationProvider ?? {
			ensure: ensureIsolation,
			cleanup: cleanupIsolation,
		};

		this.#members.set("coordinator", {
			name: "coordinator",
			role: "coordinator",
			state: "working",
			modelLabel: formatModelLabel(options.coordinatorModel),
			workspace: "inherit",
			cwd: options.cwd,
			currentActivity: "Coordinating swarm",
			lastSeenSeq: 0,
			tokens: 0,
			outputTail: [],
			pendingWake: false,
		});

		this.#unsubscribeBoard = this.board.onPost(message => {
			this.#onBoardPost(message);
		});
	}

	get title(): string {
		return this.#title;
	}

	get isDisposed(): boolean {
		return this.#disposed;
	}

	setTitle(title: string): string {
		const trimmed = title.trim();
		if (!trimmed) {
			throw new Error("Swarm title must be a non-empty string.");
		}
		this.#title = trimmed;
		return this.#title;
	}

	setCoordinatorState(state: SwarmMemberState, activity?: string): void {
		const coord = this.#members.get("coordinator");
		if (!coord) return;
		coord.state = state;
		if (activity !== undefined) {
			coord.currentActivity = activity;
		}
	}

	/** Spawn one worker (or a numbered group via `n` or `tasks`), post briefs, and kick off turns asynchronously. */
	async addWorkers(options: SwarmAddWorkerOptions): Promise<SwarmAddWorkerResult> {
		if (this.#disposed) {
			throw new Error("Swarm session has been disposed.");
		}
		const baseName = options.name.trim().toLowerCase();
		const brief = options.brief.trim();
		if (!brief) {
			throw new Error('Swarm action "add" requires a non-empty "brief".');
		}
		const workspace: "inherit" | "worktree" = options.workspace === "worktree" ? "worktree" : "inherit";
		const addedBy = options.addedBy?.trim() || "coordinator";

		const targets: Array<{ name: string; fullBrief: string }> = [];
		if (options.tasks && options.tasks.length > 0) {
			if (options.tasks.length > MAX_SHARD_COUNT) {
				throw new Error(`Cannot spawn more than ${MAX_SHARD_COUNT} workers in one add call.`);
			}
			for (let i = 0; i < options.tasks.length; i++) {
				const slice = options.tasks[i]?.trim();
				if (!slice) {
					throw new Error(`Task slice at index ${i} must be a non-empty string.`);
				}
				const workerName = `${baseName}-${i + 1}`;
				targets.push({
					name: workerName,
					fullBrief: `${brief}\n\nAssigned slice: ${slice}`,
				});
			}
		} else if (options.n !== undefined) {
			if (!Number.isInteger(options.n) || options.n < 1 || options.n > MAX_SHARD_COUNT) {
				throw new Error(`"n" must be an integer between 1 and ${MAX_SHARD_COUNT}.`);
			}
			if (options.n === 1) {
				targets.push({ name: baseName, fullBrief: brief });
			} else {
				for (let i = 1; i <= options.n; i++) {
					targets.push({ name: `${baseName}-${i}`, fullBrief: brief });
				}
			}
		} else {
			targets.push({ name: baseName, fullBrief: brief });
		}

		for (const target of targets) {
			const invalidReason = validateSwarmWorkerName(target.name);
			if (invalidReason) throw new Error(invalidReason);
			const existing = this.#members.get(target.name);
			if (existing && existing.state !== "killed") {
				throw new Error(`Worker "${target.name}" already exists (state: ${existing.state}).`);
			}
		}

		const resolvedModel = this.#resolveRequestedModel(options.model);
		if (options.model?.trim() && !resolvedModel) {
			throw new Error(`Model "${options.model.trim()}" could not be resolved from configured models.`);
		}
		const modelLabel = formatModelLabel(resolvedModel, options.model ?? formatModelLabel(this.#coordinatorModel));

		const added: string[] = [];
		const seqs: number[] = [];
		const warnings: string[] = [];

		try {
			for (const target of targets) {
				let workerCwd = this.cwd;
				let isolationHandle: IsolationHandle | undefined;
				if (workspace === "worktree") {
					try {
						isolationHandle = await this.#isolationProvider.ensure(this.cwd, `${this.swarmId}-${target.name}`);
						workerCwd = isolationHandle.mergedDir;
					} catch (err) {
						const detail = err instanceof Error ? err.message : String(err);
						warnings.push(
							`Worker "${target.name}" worktree isolation unavailable (${detail}); falling back to shared workspace.`,
						);
					}
				}

				const renderedSystemPrompt = prompt.render(swarmWorkerPromptTemplate, {
					workerName: target.name,
				});
				const swarmTools = createSwarmWorkerTools(this, target.name);

				const handle = await this.#workerFactory({
					name: target.name,
					cwd: workerCwd,
					workspace: isolationHandle ? "worktree" : "inherit",
					model: resolvedModel,
					modelPattern: options.model,
					systemPrompt: renderedSystemPrompt,
					swarmTools,
					runtime: this,
				});

				const record: WorkerRecord = {
					name: target.name,
					role: "worker",
					state: "waiting",
					modelLabel: handle.getModelLabel?.() ?? modelLabel,
					workspace: isolationHandle ? "worktree" : "inherit",
					cwd: workerCwd,
					currentActivity: "Starting assignment…",
					lastSeenSeq: this.board.head,
					tokens: 0,
					outputTail: [],
					handle,
					isolationHandle,
					pendingWake: false,
				};

				if (handle.subscribe) {
					record.unsubscribeSession = handle.subscribe(event => {
						this.#onWorkerSessionEvent(record, event);
					});
				}

				this.#members.set(target.name, record);
				added.push(target.name);

				// Post assignment on the board; the board listener immediately wakes this worker in the background.
				const posted = this.board.post(addedBy, `@${target.name} ${target.fullBrief}`);
				seqs.push(posted.seq);
			}
		} catch (err) {
			for (const name of added) {
				await this.killWorker(name).catch(() => {});
			}
			throw err;
		}

		return { added, seqs, warnings };
	}

	/** Switch a waiting worker's model in-place, preserving its conversation history. */
	async switchWorkerModel(name: string, modelPattern: string): Promise<{ name: string; model: string }> {
		const normalized = name.trim().toLowerCase();
		const record = this.#members.get(normalized);
		if (!record || record.role !== "worker") {
			throw new Error(`Unknown worker "${name}".`);
		}
		if (record.state === "killed") {
			throw new Error(`Worker "${normalized}" is killed and cannot switch models.`);
		}
		if (record.state === "working") {
			throw new Error(
				`Worker "${normalized}" is currently working; wait until it is waiting before switching models.`,
			);
		}
		const resolved = this.#resolveRequestedModel(modelPattern);
		if (!resolved) {
			throw new Error(`Model "${modelPattern}" could not be resolved from configured models.`);
		}
		if (record.handle?.setModel) {
			await record.handle.setModel(resolved);
		}
		record.modelLabel = formatModelLabel(resolved);
		this.#pushOutputLine(record, `Switched model to ${record.modelLabel}`);
		return { name: normalized, model: record.modelLabel };
	}

	/** Permanently kill a worker, aborting any active turn and cleaning up its session + worktree. */
	async killWorker(name: string): Promise<boolean> {
		const normalized = name.trim().toLowerCase();
		const record = this.#members.get(normalized);
		if (!record || record.role !== "worker") {
			return false;
		}
		if (record.state === "killed") {
			return true;
		}
		record.state = "killed";
		record.pendingWake = false;
		record.currentActivity = "Killed";
		this.#pushOutputLine(record, "Worker killed");

		record.unsubscribeSession?.();
		record.unsubscribeSession = undefined;

		if (record.handle) {
			const handle = record.handle;
			record.handle = undefined;
			try {
				await handle.abort();
			} catch {
				// Best-effort abort during kill.
			}
			try {
				await handle.dispose();
			} catch (err) {
				logger.debug("swarm worker session dispose failed", {
					worker: normalized,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (record.isolationHandle) {
			const iso = record.isolationHandle;
			record.isolationHandle = undefined;
			try {
				await this.#isolationProvider.cleanup(iso);
			} catch (err) {
				logger.warn("swarm worker worktree cleanup failed", {
					worker: normalized,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return true;
	}

	/** Stop all active workers without destroying the board log (used by Ctrl+X on the board). */
	async stopAllWorkers(): Promise<void> {
		const workers = [...this.#members.values()].filter(m => m.role === "worker" && m.state !== "killed");
		await Promise.allSettled(workers.map(worker => this.killWorker(worker.name)));
	}

	/** Return a read-only snapshot matching `@marsai-org/tui/apps/swarm-board`'s `SwarmBoardSnapshot`. */
	snapshot(): SwarmBoardSnapshot {
		const members: SwarmBoardMemberSnapshot[] = [...this.#members.values()].map(member => ({
			name: member.name,
			role: member.role,
			state: member.state,
			model: member.modelLabel,
			workspace: member.workspace,
			...(member.currentActivity !== undefined ? { currentActivity: member.currentActivity } : {}),
			...(member.lastPostSeq !== undefined ? { lastPostSeq: member.lastPostSeq } : {}),
			outputTail: [...member.outputTail],
			...(member.tokens > 0 ? { tokens: member.tokens } : {}),
		}));
		const messages: SwarmBoardMessageSnapshot[] = this.board.getAllMessages().map(msg => ({
			seq: msg.seq,
			agent: msg.agent,
			text: msg.text,
			time: msg.time,
			mentions: [...msg.mentions],
		}));
		return {
			swarmId: this.swarmId,
			title: this.#title,
			members,
			messages,
		};
	}

	/** Concise multi-line summary for `/swarm status`. */
	formatStatusText(): string {
		const snap = this.snapshot();
		const workers = snap.members.filter(m => m.role === "worker");
		const working = workers.filter(m => m.state === "working").length;
		const waiting = workers.filter(m => m.state === "waiting").length;
		const lines: string[] = [
			`Swarm "${snap.title}" (${snap.swarmId}) — ${workers.length} worker(s) (${working} working, ${waiting} waiting) · board #${this.board.head}`,
		];
		for (const member of snap.members) {
			const lastPost = member.lastPostSeq !== undefined ? ` last=#${member.lastPostSeq}` : "";
			const ws = member.workspace === "worktree" ? " [worktree]" : "";
			const activity = member.currentActivity ? ` — ${member.currentActivity}` : "";
			lines.push(`  [${member.state}] ${member.name} (${member.model})${ws}${lastPost}${activity}`);
		}
		lines.push(`  ${SWARM_OPEN_BOARD_HINT}`);
		return lines.join("\n");
	}

	/** Abort & dispose all workers, waiters, and active registry binding. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeBoard();
		this.board.dispose();
		await this.stopAllWorkers();
		await this.board.flush();
		if (activeSwarmSession === this) {
			activeSwarmSession = undefined;
		}
	}

	#resolveRequestedModel(pattern?: string): Model | undefined {
		const trimmed = pattern?.trim();
		if (!trimmed) return this.#coordinatorModel;
		const resolved = resolveCliModel({
			cliModel: trimmed,
			modelRegistry: this.#modelRegistry,
		});
		return resolved.model;
	}

	#pushOutputLine(record: WorkerRecord, line: string): void {
		const sanitized = sanitizeTailLine(line);
		if (!sanitized) return;
		record.outputTail.push(sanitized);
		if (record.outputTail.length > OUTPUT_TAIL_CAP) {
			record.outputTail.splice(0, record.outputTail.length - OUTPUT_TAIL_CAP);
		}
	}

	#onWorkerSessionEvent(record: WorkerRecord, event: AgentSessionEvent): void {
		if (record.state === "killed") return;
		const update = extractActivityFromEvent(event);
		if (update.activity !== undefined) {
			record.currentActivity = update.activity;
		}
		if (update.outputLine !== undefined) {
			this.#pushOutputLine(record, update.outputLine);
		}
		if (update.tokens !== undefined && update.tokens > 0) {
			record.tokens += update.tokens;
		}
	}

	#onBoardPost(message: SwarmBoardMessage): void {
		const sender = this.#members.get(message.agent.toLowerCase());
		if (sender) {
			sender.lastPostSeq = message.seq;
		}
		if (this.#disposed) return;

		for (const member of this.#members.values()) {
			if (member.role !== "worker") continue;
			if (member.state === "killed" || member.state === "stopped") continue;
			if (!messageMentionsMember(message, member.name)) continue;

			if (member.state === "working") {
				// Worker is mid-turn; mark pendingWake so it drains new posts immediately upon settling.
				member.pendingWake = true;
				continue;
			}
			this.#scheduleWorkerTurn(member);
		}
	}

	#scheduleWorkerTurn(record: WorkerRecord): void {
		if (this.#disposed || record.state === "killed" || !record.handle) return;
		const unread = this.board.read({ since: record.lastSeenSeq, limit: Math.max(50, this.board.head + 1) }).messages;
		if (unread.length === 0) return;

		const nextSeenSeq = unread[unread.length - 1]?.seq ?? record.lastSeenSeq;
		record.lastSeenSeq = nextSeenSeq;
		record.state = "working";
		record.pendingWake = false;
		record.currentActivity = `Processing board #${unread[0]?.seq ?? nextSeenSeq}…`;

		const turnPrompt = `New swarm message board updates (read up to #${nextSeenSeq}):\n\n${formatBoardMessagesForPrompt(unread)}\n\nAct on what is directed to @${record.name} (or @all), post your result via \`post_message\`, and end your turn when done.`;

		const handle = record.handle;
		const run = (async () => {
			try {
				await handle.prompt(turnPrompt);
			} catch (err) {
				if (record.state !== "killed" && !this.#disposed) {
					const detail = err instanceof Error ? err.message : String(err);
					this.#pushOutputLine(record, `Error: ${detail}`);
					this.board.post(record.name, `@coordinator Error during turn: ${detail}`);
				}
			} finally {
				if (record.state !== "killed") {
					record.state = "waiting";
					record.currentActivity = "Waiting on board";
					// If new messages mentioning this worker landed mid-turn, wake immediately.
					if (record.pendingWake && !this.#disposed) {
						record.pendingWake = false;
						const missed = this.board
							.read({ since: record.lastSeenSeq, limit: Math.max(50, this.board.head + 1) })
							.messages.some(msg => messageMentionsMember(msg, record.name));
						if (missed) {
							this.#scheduleWorkerTurn(record);
						}
					}
				}
			}
		})();

		record.turnPromise = run;
		void run;
	}

	async #createRealWorkerSession(params: SwarmWorkerSpawnParams): Promise<SwarmWorkerHandle> {
		const sessionManager = SessionManager.inMemory(params.cwd);
		const created = await createAgentSession({
			cwd: params.cwd,
			authStorage: this.#authStorage,
			modelRegistry: this.#modelRegistry,
			settings: this.#settings,
			sessionManager,
			model: params.model,
			...(params.modelPattern ? { modelPattern: params.modelPattern } : {}),
			appendSystemPrompt: params.systemPrompt,
			hasUI: false,
			cacheWarming: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		const session: AgentSession = created.session;
		const baseTools = session.getEnabledToolNames().filter(name => name !== "orchestrate" && name !== "swarm");
		await session.activateSwarmTools(params.swarmTools, baseTools);

		return {
			prompt: async text => {
				await session.prompt(text);
			},
			abort: () => session.abort(),
			dispose: () => session.dispose(),
			setModel: async model => {
				await session.setModel(model);
			},
			subscribe: listener => session.subscribe(listener),
			getModelLabel: () => formatModelLabel(session.model, params.modelPattern),
			getEnabledToolNames: () => session.getEnabledToolNames(),
		};
	}
}

let activeSwarmSession: SwarmSessionRuntime | undefined;

export function getActiveSwarmSession(): SwarmSessionRuntime | undefined {
	if (activeSwarmSession?.isDisposed) {
		activeSwarmSession = undefined;
	}
	return activeSwarmSession;
}

export function setActiveSwarmSession(runtime: SwarmSessionRuntime | undefined): void {
	activeSwarmSession = runtime;
}

export function clearActiveSwarmSession(): void {
	activeSwarmSession = undefined;
}
