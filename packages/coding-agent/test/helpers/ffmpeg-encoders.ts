/**
 * Encoder-aware ffmpeg fixtures for video tests.
 *
 * Tests that mux a synthetic clip must not assume `libx264`: distro ffmpeg
 * builds often ship OpenH264 instead, and a missing encoder turns a code
 * defect elsewhere into a spurious failure. Probe once per process, mirror the
 * production encoder preference through {@link selectH264Encoder}, and skip the
 * suite when the host has no H.264 encoder at all.
 */
import { parseH264EncoderNames, selectH264Encoder } from "@marsai-org/coding-agent/utils/video";
import { $which } from "@marsai-org/utils";

/** True when both ffmpeg and ffprobe are on PATH. */
export const hasFfmpegBinaries = Boolean($which("ffmpeg") && $which("ffprobe"));

/** Best available H.264 encoder, or undefined when the host ships none. */
export const h264Encoder: string | undefined = hasFfmpegBinaries ? probeH264Encoder() : undefined;

/** True when the host can mux an H.264 clip for video fixtures. */
export const hasH264Encoder = h264Encoder !== undefined;

function probeH264Encoder(): string | undefined {
	const ffmpeg = $which("ffmpeg");
	if (!ffmpeg) return undefined;
	const proc = Bun.spawnSync([ffmpeg, "-hide_banner", "-encoders"], { stdout: "pipe", stderr: "pipe" });
	const stdout = proc.stdout.toString("utf-8");
	return selectH264Encoder(parseH264EncoderNames(stdout));
}
