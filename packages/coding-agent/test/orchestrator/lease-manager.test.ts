/**
 * File lease contracts:
 * - a write lease is exclusive across workers
 * - acquisition is all-or-nothing: a conflict rejects the whole request
 * - readers never see a path another worker is writing
 * - releasing one worker lets a blocked sibling proceed
 */

import { describe, expect, test } from "bun:test";
import { FileLeaseManager } from "../../src/orchestrator/lease-manager";

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
		expect(leases.acquire("w1", [{ path: "src/a.ts", mode: "write" }]).granted).toBe(true);
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
