import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	LEGACY_RECORDING_EXTENSION,
	RECORDING_EXTENSION,
	RECORDING_EXTENSIONS,
	latestRecording,
	newRecordingPath,
	parseRecording,
} from "@marsai-org/coding-agent/stream/recording";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

const FRAME = { t: "viewport", rows: ["hello", "world"] } as const;

function header(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { cols: 80, rows: 24, title: "demo", createdAt: "2026-09-22T10:00:00.000Z", ...extra };
}

function recordingText(headerValue: Record<string, unknown>): string {
	return `${JSON.stringify(headerValue)}\n${JSON.stringify([0, FRAME])}\n`;
}

describe("recording format naming", () => {
	test("new recordings use .marscast while .ompcast stays readable", () => {
		expect(RECORDING_EXTENSION).toBe(".marscast");
		expect(LEGACY_RECORDING_EXTENSION).toBe(".ompcast");
		expect(RECORDING_EXTENSIONS).toEqual([".marscast", ".ompcast"]);
	});

	test("newRecordingPath writes the canonical extension", () => {
		const file = newRecordingPath("0123456789abcdef");
		expect(file.endsWith(".marscast")).toBe(true);
		expect(file).not.toContain(".ompcast");
	});
});

describe("recording header compatibility", () => {
	test("parses a canonical marscast header", () => {
		const recording = parseRecording(recordingText(header({ marscast: 1 })));
		expect(recording.header.marscast).toBe(1);
		expect(recording.events).toHaveLength(1);
	});

	test("parses a pre-rebrand ompcast header and normalizes the version field", () => {
		const recording = parseRecording(recordingText(header({ ompcast: 1 })));
		expect(recording.header.marscast).toBe(1);
		// The legacy field survives so a re-serialized header (clip upload) stays
		// readable by a server that only knows the old field.
		expect(recording.header.ompcast).toBe(1);
		expect(recording.events).toHaveLength(1);
	});

	test("rejects an unsupported legacy version", () => {
		expect(() => parseRecording(recordingText(header({ ompcast: 2 })))).toThrow("unsupported recording version 2");
	});

	test("rejects a header without either version field", () => {
		expect(() => parseRecording(recordingText(header()))).toThrow("unrecognized header");
	});
});

describe("recording directory discovery", () => {
	test("latestRecording picks up both .marscast and legacy .ompcast files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-recording-dir-"));
		tempRoots.push(dir);
		const recordings = path.join(dir, "mars-recordings");
		await fs.mkdir(recordings, { recursive: true });
		await Bun.write(path.join(recordings, "newest.marscast"), recordingText(header({ marscast: 1 })));
		await Bun.write(path.join(recordings, "older.ompcast"), recordingText(header({ ompcast: 1 })));
		await Bun.write(path.join(recordings, "ignored.jsonl"), recordingText(header({ marscast: 1 })));

		// Make the legacy file strictly older so ordering is deterministic.
		const older = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(recordings, "older.ompcast"), older, older);

		const tmpdir = spyOn(os, "tmpdir").mockReturnValue(dir);
		try {
			await expect(latestRecording()).resolves.toBe(path.join(recordings, "newest.marscast"));

			// Remove the canonical file: the legacy recording is still found.
			await fs.rm(path.join(recordings, "newest.marscast"));
			await expect(latestRecording()).resolves.toBe(path.join(recordings, "older.ompcast"));
		} finally {
			tmpdir.mockRestore();
		}
	});
});
