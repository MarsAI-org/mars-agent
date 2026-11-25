/**
 * Append-only numbered shared message board for Mars live Swarm sessions.
 *
 * Persists posts as JSONL under `<agentDir>/swarms/live/<swarmId>/board.jsonl`,
 * parses `@name` / `@all` / `@coordinator` mentions, and provides event-driven
 * waiters (`waitForPost`) using `Promise.withResolvers()` so neither workers
 * nor the coordinator ever poll.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@marsai-org/utils/dirs";

export interface SwarmBoardMessage {
	readonly seq: number;
	readonly agent: string;
	readonly text: string;
	readonly time: string;
	readonly mentions: readonly string[];
}

export interface SwarmBoardReadOptions {
	readonly since?: number;
	readonly limit?: number;
	readonly seqs?: readonly number[];
}

export interface SwarmBoardReadResult {
	readonly messages: readonly SwarmBoardMessage[];
	readonly head: number;
}

export interface SwarmBoardWaitOptions {
	readonly member: string;
	readonly since: number;
	readonly mentionsOnly?: boolean;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface SwarmBoardWaitResult {
	readonly messages: readonly SwarmBoardMessage[];
	readonly head: number;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}

export interface SwarmBoardOptions {
	readonly swarmId: string;
	/** Override the persisted board JSONL path (defaults to `<agentDir>/swarms/live/<swarmId>/board.jsonl`). */
	readonly filePath?: string;
	/** Override the base directory (defaults to `<agentDir>/swarms/live`). */
	readonly baseDir?: string;
	/** Set false to disable disk persistence (useful for pure in-memory unit tests). */
	readonly persist?: boolean;
	/** Injectable clock for deterministic timestamps in tests. */
	readonly now?: () => Date;
}

interface BoardWaiter {
	readonly member: string;
	readonly since: number;
	readonly mentionsOnly: boolean;
	readonly resolve: (result: SwarmBoardWaitResult) => void;
	readonly cleanup: () => void;
}

const MENTION_PATTERN = /(?:^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi;
const DEFAULT_READ_LIMIT = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/** Format a local-readable timestamp `YYYY-MM-DD HH:MM:SS` for board entries. */
function formatBoardTimestamp(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Extract normalized, deduplicated `@mentions` (without the leading `@`) from message text. */
export function parseBoardMentions(text: string): string[] {
	const mentions: string[] = [];
	const seen = new Set<string>();
	MENTION_PATTERN.lastIndex = 0;
	let match = MENTION_PATTERN.exec(text);
	while (match !== null) {
		const raw = match[1];
		if (raw) {
			const normalized = raw.toLowerCase();
			if (!seen.has(normalized)) {
				seen.add(normalized);
				mentions.push(normalized);
			}
		}
		match = MENTION_PATTERN.exec(text);
	}
	return mentions;
}

/**
 * Whether a board message targets `member`.
 *
 * Matches:
 * - `@all` (broadcast to everyone except the sender)
 * - `@<member>` (exact member name)
 * - `@<prefix>` when `member` is a numbered copy `<prefix>-<digits>` (e.g. `@worker` matches `worker-1`)
 */
export function messageMentionsMember(message: SwarmBoardMessage, member: string): boolean {
	const normalizedMember = member.toLowerCase();
	if (message.agent.toLowerCase() === normalizedMember) return false;
	const groupPrefixMatch = /^([a-z0-9][a-z0-9_-]*)-(\d+)$/.exec(normalizedMember);
	const groupPrefix = groupPrefixMatch?.[1];
	for (const mention of message.mentions) {
		if (mention === "all" || mention === normalizedMember) return true;
		if (groupPrefix !== undefined && mention === groupPrefix) return true;
	}
	return false;
}

export class SwarmBoard {
	readonly swarmId: string;
	readonly filePath: string | undefined;
	readonly #persist: boolean;
	readonly #now: () => Date;
	readonly #messages: SwarmBoardMessage[] = [];
	readonly #waiters = new Set<BoardWaiter>();
	readonly #listeners = new Set<(message: SwarmBoardMessage) => void>();
	#writeChain: Promise<void> = Promise.resolve();
	#dirCreated = false;

	constructor(options: SwarmBoardOptions) {
		this.swarmId = options.swarmId;
		this.#persist = options.persist ?? true;
		this.#now = options.now ?? (() => new Date());
		if (this.#persist) {
			const baseDir = options.baseDir ?? path.join(getAgentDir(), "swarms", "live");
			this.filePath = options.filePath ?? path.join(baseDir, this.swarmId, "board.jsonl");
		}
	}

	/** Highest sequence number currently on the board (0 when empty). */
	get head(): number {
		return this.#messages.length;
	}

	/** Snapshot of all messages in chronological order. */
	getAllMessages(): readonly SwarmBoardMessage[] {
		return [...this.#messages];
	}

	/** Subscribe to every newly posted message. Returns an unsubscribe handle. */
	onPost(listener: (message: SwarmBoardMessage) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Append a new message, persist it as JSONL, and wake matching waiters/listeners immediately. */
	post(agent: string, text: string): SwarmBoardMessage {
		const normalizedAgent = agent.trim() || "coordinator";
		const trimmedText = text.trim();
		const message: SwarmBoardMessage = {
			seq: this.#messages.length + 1,
			agent: normalizedAgent,
			text: trimmedText,
			time: formatBoardTimestamp(this.#now()),
			mentions: parseBoardMentions(trimmedText),
		};
		this.#messages.push(message);

		if (this.#persist && this.filePath) {
			const targetPath = this.filePath;
			const serialized = `${JSON.stringify(message)}\n`;
			this.#writeChain = this.#writeChain
				.then(async () => {
					if (!this.#dirCreated) {
						await fs.mkdir(path.dirname(targetPath), { recursive: true });
						this.#dirCreated = true;
					}
					await fs.appendFile(targetPath, serialized, "utf8");
				})
				.catch(() => {
					// Board persistence errors must never crash an active swarm turn.
				});
		}

		// Wake any matching waiters first so `swarm_wait` unblocks synchronously on post.
		for (const waiter of Array.from(this.#waiters)) {
			if (message.seq <= waiter.since) continue;
			if (message.agent.toLowerCase() === waiter.member.toLowerCase()) continue;
			if (waiter.mentionsOnly && !messageMentionsMember(message, waiter.member)) continue;
			this.#waiters.delete(waiter);
			waiter.cleanup();
			waiter.resolve({
				messages: this.#messagesSince(waiter.since),
				head: this.head,
				timedOut: false,
				aborted: false,
			});
		}

		for (const listener of Array.from(this.#listeners)) {
			try {
				listener(message);
			} catch {
				// Listener exceptions are isolated from board delivery.
			}
		}

		return message;
	}

	/** Wait for all queued JSONL appends to flush to disk (useful in tests & teardown). */
	async flush(): Promise<void> {
		await this.#writeChain;
	}

	/** Read messages from the board (oldest first). */
	read(options: SwarmBoardReadOptions = {}): SwarmBoardReadResult {
		if (options.seqs && options.seqs.length > 0) {
			const wanted = new Set(options.seqs.filter(n => Number.isInteger(n) && n >= 1));
			const messages = this.#messages.filter(message => wanted.has(message.seq));
			return { messages, head: this.head };
		}

		const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_READ_LIMIT));
		if (options.since !== undefined) {
			const since = Math.max(0, Math.trunc(options.since));
			const messages = this.#messages.filter(message => message.seq > since).slice(0, limit);
			return { messages, head: this.head };
		}

		const messages = this.#messages.slice(-limit);
		return { messages, head: this.head };
	}

	/**
	 * Sleep until a matching message arrives after `since` (zero polling).
	 *
	 * If a matching message already exists after `since`, resolves immediately
	 * with every message after `since` so a member never sleeps through posts
	 * that landed while it was working.
	 */
	waitForPost(options: SwarmBoardWaitOptions): Promise<SwarmBoardWaitResult> {
		const since = Math.max(0, Math.trunc(options.since));
		const mentionsOnly = options.mentionsOnly ?? true;
		const member = options.member.trim() || "coordinator";

		const missed = this.#messagesSince(since);
		const alreadyMatched = missed.some(
			msg =>
				msg.agent.toLowerCase() !== member.toLowerCase() && (!mentionsOnly || messageMentionsMember(msg, member)),
		);
		if (alreadyMatched) {
			return Promise.resolve({
				messages: missed,
				head: this.head,
				timedOut: false,
				aborted: false,
			});
		}

		if (options.signal?.aborted) {
			return Promise.resolve({
				messages: missed,
				head: this.head,
				timedOut: false,
				aborted: true,
			});
		}

		const { promise, resolve } = Promise.withResolvers<SwarmBoardWaitResult>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			options.signal?.removeEventListener("abort", onAbort);
		};

		const settle = (result: SwarmBoardWaitResult): void => {
			if (settled) return;
			settled = true;
			this.#waiters.delete(waiter);
			cleanup();
			resolve(result);
		};

		const onAbort = (): void => {
			settle({
				messages: this.#messagesSince(since),
				head: this.head,
				timedOut: false,
				aborted: true,
			});
		};

		const waiter: BoardWaiter = {
			member,
			since,
			mentionsOnly,
			resolve: result => {
				if (settled) return;
				settled = true;
				resolve(result);
			},
			cleanup,
		};

		this.#waiters.add(waiter);
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				settle({
					messages: this.#messagesSince(since),
					head: this.head,
					timedOut: true,
					aborted: false,
				});
			}, timeoutMs);
			timer.unref?.();
		}

		return promise;
	}

	/** Release all pending waiters (called on swarm disposal). */
	dispose(): void {
		for (const waiter of Array.from(this.#waiters)) {
			this.#waiters.delete(waiter);
			waiter.cleanup();
			waiter.resolve({
				messages: this.#messagesSince(waiter.since),
				head: this.head,
				timedOut: false,
				aborted: true,
			});
		}
		this.#listeners.clear();
	}

	#messagesSince(since: number): SwarmBoardMessage[] {
		return this.#messages.filter(message => message.seq > since);
	}
}

/** Load persisted board messages from a JSONL file (ignoring blank/corrupt trailing lines). */
export async function loadSwarmBoardJsonl(filePath: string): Promise<SwarmBoardMessage[]> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return [];
	const text = await file.text();
	const messages: SwarmBoardMessage[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as SwarmBoardMessage;
			if (typeof parsed.seq === "number" && typeof parsed.agent === "string" && typeof parsed.text === "string") {
				messages.push(parsed);
			}
		} catch {
			// Ignore partially written trailing lines.
		}
	}
	return messages;
}
