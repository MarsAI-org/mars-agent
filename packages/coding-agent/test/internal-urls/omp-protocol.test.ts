import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@marsai-org/coding-agent/internal-urls";

describe("OmpProtocolHandler", () => {
	it("treats mars://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("mars://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("treats omp://docs as the documentation root (legacy alias)", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("mars://tools/read.md");
		const prefixed = await router.resolve("mars://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("resolves the legacy omp:// spelling to the same content", async () => {
		const router = InternalUrlRouter.instance();
		const canonical = await router.resolve("mars://tools/read.md");
		const legacy = await router.resolve("omp://tools/read.md");

		expect(legacy.content).toBe(canonical.content);
	});

	it("keeps the spelling a docs listing was requested with", async () => {
		const router = InternalUrlRouter.instance();
		const canonical = await router.resolve("mars://");
		const legacy = await router.resolve("omp://");

		expect(canonical.content).toContain("(mars://tools/read.md)");
		expect(canonical.content).not.toContain("(omp://tools/read.md)");
		expect(legacy.content).toContain("(omp://tools/read.md)");
		expect(legacy.content).not.toContain("(mars://tools/read.md)");
	});

	it("enumerates docs with the spelling of the scope URL", async () => {
		const router = InternalUrlRouter.instance();
		const canonical = await router.enumerate("mars://");
		const legacy = await router.enumerate("omp://");

		expect(canonical?.some(entry => entry.url === "mars://tools/read.md")).toBe(true);
		expect(legacy?.some(entry => entry.url === "omp://tools/read.md")).toBe(true);
	});

	it("accepts both schemes as built-in, with the canonical one advertised", async () => {
		const router = InternalUrlRouter.instance();

		expect(router.isBuiltin("mars")).toBe(true);
		expect(router.isBuiltin("omp")).toBe(true);
		expect(router.spec("mars")).toEqual(router.spec("omp"));
	});

	it("rejects traversal and absolute paths under both spellings", async () => {
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mars://../etc/passwd")).rejects.toThrow(
			"Path traversal (..) is not allowed in mars:// URLs",
		);
		await expect(router.resolve("omp://../etc/passwd")).rejects.toThrow(
			"Path traversal (..) is not allowed in omp:// URLs",
		);
	});
});
