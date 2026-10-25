/**
 * Issue #80: resuming a session must land bottom-anchored in one frame without creep.
 *
 * When a long transcript resumes into a terminal with a welcome header:
 * - Header and the overflowing transcript prefix retire together in ONE batch.
 * - The overflowing prefix is not chunked by RETIREMENT_BUDGET_MS.
 * - The live viewport shows the trailing messages (tail), not the top.
 */

import { describe, expect, it } from "bun:test";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import type { Component } from "@marsai-org/tui";
import { Composer } from "@marsai-org/tui/prompt/composer";
import { TranscriptContainer } from "@marsai-org/tui/chrome/transcript-container";
import { VirtualTerminal } from "./virtual-terminal";

class SlowMessage implements Component {
	readonly #rows: readonly string[];
	constructor(id: string, lines = 4) {
		this.#rows = Array.from({ length: lines }, (_, i) => `${id} row ${i}`);
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
	render(): readonly string[] {
		// Simulate non-trivial markdown rendering time
		const until = performance.now() + 1.2;
		while (performance.now() < until) {}
		return this.#rows;
	}
}

describe("issue #80 — resume lands bottom-anchored in one frame", () => {
	withoutTerminalMultiplexer();

	it("retires the overflowing prefix in one batch with peekResumeBatch", () => {
		const transcript = new TranscriptContainer();
		for (let i = 1; i <= 30; i++) transcript.addChild(new SlowMessage(`m${i}`, 4));

		// With a terminal of capacity 10 rows (fits ~2 blocks of 4 rows):
		// peekResumeBatch must return the entire overflowing prefix in ONE batch.
		const batch = transcript.peekResumeBatch(80, 10);
		expect(batch).toBeDefined();
		expect(batch!.rows.length).toBeGreaterThan(50);
		expect(batch!.rows[0]).toContain("m1");

		transcript.acknowledgeFinalizedBatch(batch!.id);

		// After acknowledging, no second batch should be needed
		const second = transcript.peekResumeBatch(80, 10);
		expect(second).toBeUndefined();

		// And the live viewport contains the tail (m28..m30), not the head
		const viewport = transcript.renderViewport(80, 10, { tick: 0, now: 0 });
		expect(viewport.length).toBeGreaterThan(0);
		expect(viewport.some(r => r.includes("m30"))).toBe(true);
		expect(viewport.some(r => r.includes("m1"))).toBe(false);
	});

	it("retires welcome header and transcript overflow together in composer", () => {
		const term = new VirtualTerminal(80, 15);
		const composer = new Composer({ terminal: term });
		const transcript = new TranscriptContainer();
		for (let i = 1; i <= 30; i++) transcript.addChild(new SlowMessage(`m${i}`, 4));

		composer.setRuntimeChildren([transcript]);
		composer.start({ clearScrollback: false, playWelcomeIntro: false });
		// The app signals a resumed transcript explicitly; mounting alone must not
		// take the one-shot path, or every remount would collapse its ledger here.
		composer.notifyFreshTranscript();
		const plan = composer.renderFrame({ columns: 80, rows: 15 });
		expect(plan.history).toBeDefined();

		// Both the header AND the transcript rows must be in the history batch!
		expect(plan.history!.rows.some(r => r.includes("m1"))).toBe(true);
		expect(plan.history!.rows.length).toBeGreaterThan(50);

		// And the viewport already shows the tail
		expect(plan.viewport.some(r => r.includes("m30"))).toBe(true);
		expect(plan.viewport.some(r => r.includes("m1"))).toBe(false);
	});
});
