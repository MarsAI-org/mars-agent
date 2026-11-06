/**
 * Video selector parsing: bare integers are frame indices, timestamp shapes
 * are seek positions. Locks the `:412` vs `:1h5m42s` contract the read tool,
 * @mentions, and composer paste all share — a bare `:90` must stay a frame,
 * never silently become 90 seconds.
 */
import { describe, expect, it } from "bun:test";
import {
	formatVideoTimestamp,
	parseH264EncoderNames,
	parseVideoSelector,
	parseVideoTimestamp,
	selectH264Encoder,
	splitVideoReadTarget,
} from "@marsai-org/coding-agent/utils/video";

describe("parseVideoSelector", () => {
	it("reads a bare integer as a frame index", () => {
		expect(parseVideoSelector("412")).toEqual({ kind: "frame", frame: 412 });
	});

	it("reads f/frame-prefixed integers as frame indices", () => {
		expect(parseVideoSelector("f7")).toEqual({ kind: "frame", frame: 7 });
		expect(parseVideoSelector("frame102")).toEqual({ kind: "frame", frame: 102 });
	});

	it("reads unit timestamps as seek positions", () => {
		expect(parseVideoSelector("90s")).toEqual({ kind: "time", seconds: 90, raw: "90s" });
		expect(parseVideoSelector("1h5m42s")).toEqual({ kind: "time", seconds: 3942, raw: "1h5m42s" });
		expect(parseVideoSelector("5m30s")).toEqual({ kind: "time", seconds: 330, raw: "5m30s" });
	});

	it("reads colon timestamps as seek positions", () => {
		expect(parseVideoSelector("01:23")).toEqual({ kind: "time", seconds: 83, raw: "01:23" });
		expect(parseVideoSelector("1:02:03")).toEqual({ kind: "time", seconds: 3723, raw: "1:02:03" });
	});

	it("reads fractional seconds as a seek position, not a frame", () => {
		expect(parseVideoSelector("42.5")).toEqual({ kind: "time", seconds: 42.5, raw: "42.5" });
	});

	it("rejects line-range shapes so text selectors stay text errors", () => {
		expect(parseVideoSelector("50-200")).toBeNull();
		expect(parseVideoSelector("raw")).toBeNull();
		expect(parseVideoSelector("img")).toBeNull();
		expect(parseVideoSelector(undefined)).toBeNull();
	});
});

describe("parseVideoTimestamp", () => {
	it("parses minute-only units", () => {
		expect(parseVideoTimestamp("5m")).toBe(300);
	});

	it("rejects non-timestamp shapes", () => {
		expect(parseVideoTimestamp("412")).toBeNull();
		expect(parseVideoTimestamp("abc")).toBeNull();
	});
});

describe("formatVideoTimestamp", () => {
	it("formats sub-hour positions as m:ss", () => {
		expect(formatVideoTimestamp(83)).toBe("1:23");
	});

	it("formats hour positions with h/m/s units", () => {
		expect(formatVideoTimestamp(3942)).toBe("1h5m42s");
	});
});

describe("splitVideoReadTarget", () => {
	it("splits a timestamp suffix off a video path", () => {
		expect(splitVideoReadTarget("clip.mp4:1h5m42s")).toEqual({ path: "clip.mp4", sel: "1h5m42s" });
	});

	it("splits a frame suffix off a video path", () => {
		expect(splitVideoReadTarget("clip.mp4:412")).toEqual({ path: "clip.mp4", sel: "412" });
	});

	it("leaves non-video paths and non-selector suffixes alone", () => {
		expect(splitVideoReadTarget("notes.txt:12")).toBeNull();
		expect(splitVideoReadTarget("clip.mp4:50-200")).toBeNull();
		expect(splitVideoReadTarget("clip.mp4")).toBeNull();
	});
});

describe("parseH264EncoderNames", () => {
	// `ffmpeg -encoders` section header + rows; only H.264-capable rows count.
	const ENCODERS_OUTPUT = [
		"Encoders:",
		" V..... = Video",
		" -----",
		" V....D libx264              libx264 H.264 / AVC (codec h264)",
		" V....D libopenh264          OpenH264 H.264 / AVC (codec h264)",
		" V..... h264_qsv             H.264 (Intel Quick Sync Video) (codec h264)",
		" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
		" V....D libvpx-vp9           libvpx VP9 (codec vp9)",
		" A....D aac                  AAC (Advanced Audio Coding) (codec aac)",
	].join("\n");

	it("extracts only the H.264 encoder names", () => {
		expect(parseH264EncoderNames(ENCODERS_OUTPUT)).toEqual(["libx264", "libopenh264", "h264_qsv", "h264_nvenc"]);
	});

	it("returns an empty list when no H.264 encoder is present", () => {
		const vpOnly = [" V....D libvpx-vp9           libvpx VP9 (codec vp9)"].join("\n");
		expect(parseH264EncoderNames(vpOnly)).toEqual([]);
	});
});

describe("selectH264Encoder", () => {
	it("prefers libx264 when present", () => {
		expect(selectH264Encoder(["h264_nvenc", "libx264", "libopenh264"])).toBe("libx264");
	});

	it("falls back through software encoders before hardware ones", () => {
		expect(selectH264Encoder(["h264_vaapi", "libopenh264"])).toBe("libopenh264");
		expect(selectH264Encoder(["h264_nvenc", "h264_qsv"])).toBe("h264_nvenc");
	});

	it("uses any available H.264 encoder when none is preferred", () => {
		expect(selectH264Encoder(["some_future_h264"])).toBe("some_future_h264");
	});

	it("returns undefined when no H.264 encoder exists", () => {
		expect(selectH264Encoder([])).toBeUndefined();
	});
});
