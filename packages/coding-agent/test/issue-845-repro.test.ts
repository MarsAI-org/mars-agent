import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveUpdateTargetFromPath } from "@marsai-org/coding-agent/cli/update-cli";
import { removeSyncWithRetries } from "@marsai-org/utils";

// Issue #845: on Windows with Bun installed via Scoop, ~/.bun is a junction
// to scoop\persist\Oven-sh.Bun\.bun. `bun pm bin -g` and the mars path that
// $which finds may end up referring to the same directory through different
// path strings (one through the junction, one through the real target).
// `isPathInDirectory` must follow filesystem links so a legacy bun symlink
// reached through a symlinked bin dir is recognized for in-place takeover
// instead of being treated as a foreign symlink.

describe("issue-845: resolveUpdateTargetFromPath follows symlinks/junctions", () => {
	let tmpRoot: string;
	let realBinDir: string;
	let linkedBinDir: string;
	let ompPathViaLink: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mars-issue-845-"));
		const realInstallRoot = path.join(tmpRoot, "real");
		realBinDir = path.join(realInstallRoot, "bin");
		const managedCli = path.join(
			realInstallRoot,
			"install",
			"global",
			"node_modules",
			"@marsai-org",
			"coding-agent",
			"dist",
			"cli.js",
		);
		fs.mkdirSync(realBinDir, { recursive: true });
		fs.mkdirSync(path.dirname(managedCli), { recursive: true });
		fs.writeFileSync(managedCli, "#!/usr/bin/env bun\n", { mode: 0o755 });
		fs.symlinkSync(managedCli, path.join(realBinDir, "mars"));

		linkedBinDir = path.join(tmpRoot, "link-bin");
		fs.symlinkSync(realBinDir, linkedBinDir, "dir");
		ompPathViaLink = path.join(linkedBinDir, "mars");
	});

	afterAll(() => {
		removeSyncWithRetries(tmpRoot);
	});

	it("takes over a legacy bun launcher reached through a symlinked bin dir", () => {
		const target = resolveUpdateTargetFromPath(ompPathViaLink, realBinDir);
		expect(target).toEqual({
			method: "binary",
			path: ompPathViaLink,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
	});

	it("takes over a legacy bun launcher at the real bin dir when bunBinDir is symlinked", () => {
		const ompAtReal = path.join(realBinDir, "mars");
		const target = resolveUpdateTargetFromPath(ompAtReal, linkedBinDir);
		expect(target).toEqual({
			method: "binary",
			path: ompAtReal,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
	});
});
