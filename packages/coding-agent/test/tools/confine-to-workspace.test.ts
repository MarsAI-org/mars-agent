import { describe, expect, it } from "bun:test";

import * as fs from "node:fs";
import * as path from "node:path";
import { confineToWorkspace } from "@marsai-org/coding-agent/tools/path-utils";
import { TempDir } from "@marsai-org/utils";

/**
 * `confineToWorkspace` is the boundary a model-driven download passes through:
 * the caller names a file, the helper says whether that name can land inside the
 * workspace. Every case below is a shape that has to be answered from the path
 * alone, so the cases are worth pinning one at a time.
 */
function makeWorkspace(tempDir: TempDir): string {
	const root = path.join(tempDir.path(), "ws");
	fs.mkdirSync(path.join(root, "sub"), { recursive: true });
	return root;
}

describe("confineToWorkspace", () => {
	it("accepts a plain relative name", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("out.txt", root)).toBe(path.join(root, "out.txt"));
	});

	it("accepts a relative path through existing and missing directories", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("sub/out.txt", root)).toBe(path.join(root, "sub/out.txt"));
		expect(confineToWorkspace("missing/deeper/out.txt", root)).toBe(path.join(root, "missing/deeper/out.txt"));
	});

	it("accepts '..' segments that stay inside the workspace", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("sub/../out.txt", root)).toBe(path.join(root, "out.txt"));
	});

	it("refuses absolute paths, including ones already inside the workspace", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("/etc/passwd", root)).toBeNull();
		expect(confineToWorkspace(path.join(root, "out.txt"), root)).toBeNull();
	});

	it("refuses paths that climb out of the workspace", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("../out.txt", root)).toBeNull();
		expect(confineToWorkspace("sub/../../out.txt", root)).toBeNull();
	});

	it("refuses '~' and the workspace directory itself", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("~/out.txt", root)).toBeNull();
		expect(confineToWorkspace("", root)).toBeNull();
		expect(confineToWorkspace(".", root)).toBeNull();
	});

	it("refuses a name that is an internal URL scheme", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);

		expect(confineToWorkspace("artifact://session/1/file.txt", root)).toBeNull();
	});

	it("refuses a symlink that resolves outside the workspace", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(root, "link"), "dir");

		expect(confineToWorkspace("link/out.txt", root)).toBeNull();
	});

	it("refuses a dangling symlink, whose destination cannot be verified", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);
		fs.symlinkSync(path.join(tempDir.path(), "nowhere"), path.join(root, "dangling"));

		expect(confineToWorkspace("dangling", root)).toBeNull();
	});

	it("accepts a workspace that is itself reached through a symlink", () => {
		using tempDir = TempDir.createSync("@confine-");
		const root = makeWorkspace(tempDir);
		const linkedRoot = path.join(tempDir.path(), "ws-link");
		fs.symlinkSync(root, linkedRoot, "dir");

		expect(confineToWorkspace("out.txt", linkedRoot)).toBe(path.join(linkedRoot, "out.txt"));
	});

	it("refuses every name when the workspace cannot be resolved", () => {
		using tempDir = TempDir.createSync("@confine-");
		const missingRoot = path.join(tempDir.path(), "not-there");

		expect(confineToWorkspace("out.txt", missingRoot)).toBeNull();
	});
});
