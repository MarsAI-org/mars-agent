/**
 * `test:py` chains two pytest runs because both Python trees ship a `tests`
 * package. A single run imports whichever it collected first, and the second
 * tree then resolves `tests.*` to the wrong root and fails collection:
 *
 *   ERROR sdk/python/omp-rpc/tests/test_client.py
 *   E   ModuleNotFoundError: No module named 'tests.test_client'
 *
 * That is an invocation constraint, not a style preference, so pin it: if
 * someone merges the runs, or a tree drops its `__init__.py` and the reason
 * disappears, this fails loudly instead of the suite reddening in CI.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const PYTHON_TEST_TREES = ["sdk/python/omp-rpc/tests", "python/robomp/tests"];

function packageJsonScript(name: string): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const script = manifest.scripts[name];
	if (script === undefined) throw new Error(`package.json has no "${name}" script`);
	return script;
}

describe("test:py invocation", () => {
	it("runs each Python test tree as its own pytest process", () => {
		const script = packageJsonScript("test:py");
		const runs = script.match(/pytest[^&|]*/g) ?? [];
		expect(runs).toHaveLength(PYTHON_TEST_TREES.length);
		for (const tree of PYTHON_TEST_TREES) {
			// Each tree must appear in a run, and no run may carry more than one tree.
			const carrying = runs.filter(run => run.includes(tree));
			expect(carrying).toHaveLength(1);
			expect(carrying[0]!.split(" ").filter(part => part.endsWith("/tests")).length).toBe(1);
		}
	});

	it("keeps a package marker in both trees, which is what makes one run ambiguous", () => {
		// If a tree stops being a package the two-run separation could be relaxed;
		// this asserts the reason is still real rather than silently stale.
		for (const tree of PYTHON_TEST_TREES) {
			expect(fs.existsSync(path.join(repoRoot, tree, "__init__.py"))).toBe(true);
		}
	});
});
