/**
 * File lease contracts:
 * - a write lease is exclusive across workers
 * - paths are normalized (`./`, `..`, `\`, optional `root`) before comparison
 * - directory containment (`src/a` vs `src/a/b.ts`) conflicts in both directions
 * - acquisition is all-or-nothing: a conflict rejects the whole request
 * - releasing one worker lets a blocked sibling proceed
 */

import { describe, expect, test } from "bun:test";
import { FileLeaseManager, leasePathsConflict, normalizeLeasePath } from "../../src/orchestrator/lease-manager";

describe("FileLeaseManager", () => {
	test("grants a write lease and rejects a second writer", () => {
		const leases = new FileLeaseManager();
		const first = leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]);
		expect(first.granted).toBe(true);

		const second = leases.acquire("w2", [{ path: "src/a.ts", mode: "write" }]);
		expect(second.granted).toBe(false);
		expect(second.conflicts.map(c => c.path)).toEqual(["src/a.ts"]);
		expect(second.conflicts[0]?.workerId).toBe("w1");
		expect(leases.canWrite("w2", "src/a.ts")).toBe(false);
	});

	test("normalizes equivalent relative, dotted, and backslash paths to detect conflicts", () => {
		const leases = new FileLeaseManager({ root: "/workspace/repo" });
		expect(normalizeLeasePath("./src\\dir/../a.ts", "/workspace/repo")).toBe("src/a.ts");

		const first = leases.acquire("w1", [{ path: "./src/a.ts", mode: "write" }]);
		expect(first.granted).toBe(true);
		expect(first.leases[0]?.path).toBe("src/a.ts");

		const dotted = leases.acquire("w2", [{ path: "src/sub/../a.ts", mode: "write" }]);
		expect(dotted.granted).toBe(false);

		const backslash = leases.acquire("w2", [{ path: "src\\a.ts", mode: "write" }]);
		expect(backslash.granted).toBe(false);

		const absolute = leases.acquire("w2", [{ path: "/workspace/repo/src/a.ts", mode: "write" }]);
		expect(absolute.granted).toBe(false);
		expect(leases.writeHolder("./src/dir/../a.ts")).toBe("w1");
	});

	test("detects directory containment conflicts in both directions", () => {
		expect(leasePathsConflict("src/a", "src/a/b.ts")).toBe(true);
		expect(leasePathsConflict("src/a/b.ts", "src/a")).toBe(true);
		expect(leasePathsConflict("src/a", "src/ab/b.ts")).toBe(false);

		const leases = new FileLeaseManager();
		expect(leases.acquire("w1", [{ path: "src/a", mode: "write" }]).granted).toBe(true);

		// Child file under leased directory must conflict.
		const childReq = leases.acquire("w2", [{ path: "src/a/b.ts", mode: "write" }]);
		expect(childReq.granted).toBe(false);
		expect(childReq.conflicts[0]?.workerId).toBe("w1");
		expect(leases.canWrite("w2", "src/a/b.ts")).toBe(false);

		// Sibling directory with shared prefix must not conflict.
		expect(leases.acquire("w2", [{ path: "src/ab/b.ts", mode: "write" }]).granted).toBe(true);
		leases.release("w1");
		leases.release("w2");

		// Parent directory over leased child file must also conflict.
		expect(leases.acquire("w1", [{ path: "src/a/nested/c.ts", mode: "write" }]).granted).toBe(true);
		const parentReq = leases.acquire("w2", [{ path: "src/a", mode: "write" }]);
		expect(parentReq.granted).toBe(false);
		expect(parentReq.conflicts[0]?.workerId).toBe("w1");
	});

	test("acquisition is all-or-nothing across the request", () => {
		const leases = new FileLeaseManager();
		leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]);
		const result = leases.acquire("w2", [
			{ path: "src/free.ts", mode: "write" },
			{ path: "src/a.ts", mode: "write" },
		]);
		expect(result.granted).toBe(false);
		expect(result.leases).toEqual([]);
		// The free path was not partially leased to w2.
		expect(leases.writeHolder("src/free.ts")).toBeUndefined();
	});

	test("read leases are advisory and never block a writer", () => {
		const leases = new FileLeaseManager();
		expect(leases.acquire("r1", [{ path: "src/a.ts", mode: "read" }]).granted).toBe(true);
		expect(leases.acquire("r2", [{ path: "src/a.ts", mode: "read" }]).granted).toBe(true);
		// Workers run in isolated checkouts, so readers never observe a sibling's
		// in-flight writes; only write leases conflict with write leases.
		expect(leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(true);
		expect(leases.canWrite("w1", "src/a.ts")).toBe(true);
		expect(leases.acquire("w2", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(false);
		leases.release("w1");
		expect(leases.acquire("w2", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(true);
	});

	test("re-acquiring the same lease is idempotent for the holder", () => {
		const leases = new FileLeaseManager();
		leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]);
		expect(leases.acquire("w1", [{ path: "./src/a.ts", mode: "write" }]).granted).toBe(true);
	});

	test("releasing a worker frees its paths for a blocked sibling", () => {
		const leases = new FileLeaseManager();
		leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]);
		expect(leases.acquire("w2", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(false);
		leases.release("w1");
		expect(leases.canWrite("w2", "src/a.ts")).toBe(true);
		expect(leases.acquire("w2", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(true);
	});
});
