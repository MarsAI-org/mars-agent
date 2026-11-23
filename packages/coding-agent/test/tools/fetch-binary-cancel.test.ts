import { afterEach, describe, expect, test, vi } from "bun:test";
import { fetchBinary } from "@marsai-org/coding-agent/web/scrapers/utils";

describe("fetchBinary body cancellation on early error returns", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeTrackedResponse(init: ResponseInit): { response: Response; cancelled: () => boolean } {
		let wasCancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				wasCancelled = true;
			},
		});
		return {
			response: new Response(stream, init),
			cancelled: () => wasCancelled,
		};
	}

	test("cancels response body on non-OK HTTP status", async () => {
		const { response, cancelled } = makeTrackedResponse({ status: 502 });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		const result = await fetchBinary("https://example.test/file.bin");

		expect(result).toEqual({ ok: false, error: "HTTP 502" });
		expect(cancelled()).toBe(true);
	});

	test("cancels response body when Content-Length exceeds MAX_BYTES", async () => {
		const { response, cancelled } = makeTrackedResponse({
			status: 200,
			headers: { "content-length": String(100 * 1024 * 1024) },
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		const result = await fetchBinary("https://example.test/huge.bin");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("exceeds");
		}
		expect(cancelled()).toBe(true);
	});
});
