/**
 * Session recordings (`/record`, `mars play`).
 *
 * A recording is the single-pane `mars stream` feed persisted to disk: the same
 * normalized, redacted screen frames {@link StreamPaintEncoder} produces for
 * live viewers, stamped with their offset from the start of the recording.
 *
 * File format (`.marscast`, JSON Lines, asciicast-like):
 *
 * ```text
 * {"marscast":1,"cols":120,"rows":40,"title":"pi","createdAt":"2026-09-22T10:00:00.000Z"}
 * [0,{"t":"viewport","rows":["…","…"]}]
 * [51,{"t":"patch","ops":[[39,"…"]],"rows":40}]
 * [880,{"t":"history","rows":["…"]}]
 * ```
 *
 * Line 1 is the header; every following line is `[ms, frame]` where `frame` is
 * a {@link StreamScreenFrame}. A truncated final line (recorder killed
 * mid-write) is ignored on load.
 *
 * Backward compatibility: recordings written before the rebrand use the
 * `.ompcast` extension and a `{"ompcast":1,...}` header. Both are still read;
 * the parsed header normalizes the version field to `marscast`, so callers see
 * one shape regardless of which format produced the file.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@marsai-org/tui";
import { isEnoent } from "@marsai-org/utils";
import { STREAM_FLUSH_INTERVAL_MS, StreamPaintEncoder } from "./paint-encoder";
import { isDimension, isSessionFrame, type StreamScreenFrame } from "./protocol";
import type { StreamRedactor } from "./redactor";

export const RECORDING_VERSION = 1;
/** Extension for new recordings. */
export const RECORDING_EXTENSION = ".marscast";
/** Pre-rebrand extension; still recognized so existing recordings keep playing. */
export const LEGACY_RECORDING_EXTENSION = ".ompcast";
/** Every extension a recording may use on disk. */
export const RECORDING_EXTENSIONS: readonly string[] = [RECORDING_EXTENSION, LEGACY_RECORDING_EXTENSION];

/** First line of a recording file. */
export interface RecordingHeader {
	/** Format version. Written by new recordings. */
	marscast: number;
	/** Pre-rebrand version field, accepted on read only. */
	ompcast?: number;
	cols: number;
	rows: number;
	title: string;
	createdAt: string;
	/** Clip description, set by `mars clip --description`. */
	description?: string;
	/** Uploading Stencil username, stamped by the clip server. */
	owner?: string;
}

/** One timestamped screen frame; `at` is milliseconds since the recording started. */
export interface RecordingEvent {
	at: number;
	frame: StreamScreenFrame;
}

export interface Recording {
	header: RecordingHeader;
	events: RecordingEvent[];
}

/** Directory `/record` writes into (temporary storage for now). */
export function recordingsDir(): string {
	return path.join(os.tmpdir(), "mars-recordings");
}

/** Fresh, sortable recording path for one session: `<recordingsDir>/<utc-stamp>-<session>.marscast`. */
export function newRecordingPath(sessionId: string): string {
	const stamp = new Date()
		.toISOString()
		.replace(/\.\d+Z$/, "")
		.replaceAll(":", "-");
	return path.join(recordingsDir(), `${stamp}-${sessionId.slice(0, 8)}${RECORDING_EXTENSION}`);
}

/** Newest recording in {@link recordingsDir}, or null when there is none. */
export async function latestRecording(): Promise<string | null> {
	const dir = recordingsDir();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	let latest: { file: string; mtimeMs: number } | null = null;
	for (const name of names) {
		if (!RECORDING_EXTENSIONS.some(extension => name.endsWith(extension))) continue;
		const file = path.join(dir, name);
		const { mtimeMs } = await fs.stat(file);
		if (!latest || mtimeMs > latest.mtimeMs) latest = { file, mtimeMs };
	}
	return latest?.file ?? null;
}

/**
 * Parse a recording file's contents.
 *
 * @throws {Error} when the header is missing/unsupported or a complete line is
 *   not a valid `[ms, frame]` event.
 */
export function parseRecording(text: string): Recording {
	const { values, error } = Bun.JSONL.parseChunk(text);
	if (error) throw new Error(`malformed recording: ${error.message}`);
	const [rawHeader, ...lines] = values;
	const header = normalizeRecordingHeader(rawHeader);
	if (!header) throw new Error("not a Mars recording (unrecognized header)");
	if (header.marscast !== RECORDING_VERSION) {
		throw new Error(`unsupported recording version ${header.marscast}`);
	}
	const events: RecordingEvent[] = [];
	for (const [index, line] of lines.entries()) {
		if (
			!Array.isArray(line) ||
			line.length !== 2 ||
			!isDimension(line[0]) ||
			!isSessionFrame(line[1]) ||
			line[1].t === "hello" ||
			line[1].t === "paused"
		) {
			throw new Error(`malformed recording event on line ${index + 2}`);
		}
		events.push({ at: line[0], frame: line[1] });
	}
	return { header, events };
}

/**
 * Accept both header shapes and normalize the version field to `marscast`.
 *
 * A pre-rebrand header keeps its `ompcast` field in the returned object so
 * re-serializing it (clip upload) stays byte-compatible with servers that
 * still read the old field.
 */
function normalizeRecordingHeader(value: unknown): RecordingHeader | null {
	if (!value || typeof value !== "object") return null;
	const header = value as Record<string, unknown>;
	const version = typeof header.marscast === "number" ? header.marscast : header.ompcast;
	if (
		typeof version !== "number" ||
		!isDimension(header.cols) ||
		!isDimension(header.rows) ||
		typeof header.title !== "string" ||
		typeof header.createdAt !== "string"
	) {
		return null;
	}
	return { ...(header as unknown as RecordingHeader), marscast: version };
}

export interface SessionRecorderOptions {
	tui: TUI;
	redactor: StreamRedactor;
	title: string;
	/** Destination file; parent directories are created. */
	path: string;
}

/** Records one interactive session's painted screen to a `.marscast` file. */
export class SessionRecorder {
	readonly path: string;
	readonly #encoder: StreamPaintEncoder;
	readonly #writer: Bun.FileSink;
	readonly #startedAt = performance.now();
	#lastPaintAt = 0;
	#flushTimer: NodeJS.Timeout | undefined;
	#unsubscribe: (() => void) | undefined;

	/** Open the file, write the header, and start observing paints. */
	static async start(options: SessionRecorderOptions): Promise<SessionRecorder> {
		await fs.mkdir(path.dirname(options.path), { recursive: true });
		return new SessionRecorder(options);
	}

	private constructor(options: SessionRecorderOptions) {
		this.path = options.path;
		const size = { columns: options.tui.terminal.columns, rows: options.tui.terminal.rows };
		this.#encoder = new StreamPaintEncoder(size, options.redactor);
		this.#writer = Bun.file(options.path).writer();
		const header: RecordingHeader = {
			marscast: RECORDING_VERSION,
			cols: size.columns,
			rows: size.rows,
			title: options.title,
			createdAt: new Date().toISOString(),
		};
		this.#writer.write(`${JSON.stringify(header)}\n`);
		this.#unsubscribe = options.tui.addPaintListener(paint => {
			this.#encoder.push(paint);
			this.#lastPaintAt = performance.now() - this.#startedAt;
			this.#flushTimer ??= setTimeout(() => {
				this.#flushTimer = undefined;
				this.#flush();
			}, STREAM_FLUSH_INTERVAL_MS).unref();
		});
		// Seed the recording with the current screen instead of waiting for the next change.
		options.tui.requestRender(true);
	}

	/** Milliseconds recorded so far. */
	get elapsedMs(): number {
		return performance.now() - this.#startedAt;
	}

	/** Stop observing, write pending frames, and close the file. Idempotent. */
	async stop(): Promise<void> {
		if (!this.#unsubscribe) return;
		this.#unsubscribe();
		this.#unsubscribe = undefined;
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#flush();
		await this.#writer.end();
	}

	#flush(): void {
		const at = Math.round(this.#lastPaintAt);
		let chunk = "";
		for (const frame of this.#encoder.drain()) chunk += `${JSON.stringify([at, frame])}\n`;
		if (!chunk) return;
		this.#writer.write(chunk);
		this.#writer.flush();
	}
}
