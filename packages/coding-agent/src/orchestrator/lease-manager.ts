/**
 * File write-lease manager.
 *
 * Workers declare the files they intend to write before they start. A write
 * lease is exclusive: while one worker holds `path` for writing, no other
 * worker may acquire it (or any ancestor/descendant directory containing it).
 * Read leases are shared and never conflict with each other or with the
 * holder's own write lease.
 *
 * Acquisition is all-or-nothing so a worker never ends up with a partial lease
 * set that would have to be rolled back mid-run. The orchestrator retries
 * rejected acquisitions when the holder finishes.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md section 5.
 */

import * as path from "node:path";
import type { FileLease, FileLeaseRequest, FileLeaseResult } from "./types";

/** Per-worker lease bookkeeping. */
interface WorkerLeases {
	write: Set<string>;
	read: Set<string>;
}

export interface LeaseManagerOptions {
	/** Injected clock for deterministic tests. */
	now?: () => number;
	/** Optional root directory to resolve relative and absolute paths against. */
	root?: string;
}

/**
 * Normalize a lease path into a canonical POSIX path (`\` -> `/`, leading `./`
 * stripped, `..` collapsed, trailing `/` stripped, and relativized against
 * `root` when provided).
 */
export function normalizeLeasePath(rawPath: string, root?: string): string {
	const slashed = rawPath.trim().replace(/\\/g, "/");
	if (slashed.length === 0) return ".";

	let normalized: string;
	if (root !== undefined && root.trim().length > 0) {
		const cleanRoot = path.posix.resolve("/", root.trim().replace(/\\/g, "/"));
		const cleanTarget = path.posix.resolve(cleanRoot, slashed);
		normalized = path.posix.relative(cleanRoot, cleanTarget);
	} else {
		normalized = path.posix.normalize(slashed);
	}

	if (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.replace(/\/+$/, "");
	}
	return normalized.length === 0 ? "." : normalized;
}

/**
 * Whether two normalized lease paths conflict (exact match or directory
 * containment in either direction, e.g. `src/a` vs `src/a/b.ts`).
 */
export function leasePathsConflict(a: string, b: string): boolean {
	if (a === b) return true;
	if (a === "." || b === ".") return true;
	const aPrefix = a.endsWith("/") ? a : `${a}/`;
	const bPrefix = b.endsWith("/") ? b : `${b}/`;
	return b.startsWith(aPrefix) || a.startsWith(bPrefix);
}

export class FileLeaseManager {
	readonly #now: () => number;
	readonly #root: string | undefined;
	readonly #writeHolders = new Map<string, string>();
	readonly #readHolders = new Map<string, Set<string>>();
	readonly #byWorker = new Map<string, WorkerLeases>();

	constructor(options: LeaseManagerOptions = {}) {
		this.#now = options.now ?? (() => Date.now());
		this.#root = options.root;
	}

	/**
	 * Acquire every requested lease or none of them.
	 *
	 * Write leases are exclusive: while one worker holds `path` for writing, no
	 * other worker may acquire `path` or any enclosing/contained path for writing.
	 * Read leases are advisory (each worker runs in its own checkout, so a reader
	 * never observes another worker's in-flight writes) and never conflict with
	 * anything.
	 *
	 * Re-acquiring a lease the same worker already holds succeeds (idempotent),
	 * so a retry loop in the orchestrator never deadlocks on its own holder.
	 */
	acquire(workerId: string, requests: readonly FileLeaseRequest[]): FileLeaseResult {
		const normalizedRequests = requests.map(req => ({
			path: normalizeLeasePath(req.path, this.#root),
			mode: req.mode,
		}));

		const conflicts: FileLease[] = [];
		for (const request of normalizedRequests) {
			if (request.mode !== "write") continue;
			for (const [heldPath, holder] of this.#writeHolders) {
				if (holder !== workerId && leasePathsConflict(request.path, heldPath)) {
					conflicts.push({
						path: heldPath,
						mode: "write",
						workerId: holder,
						acquiredAt: this.#now(),
					});
				}
			}
		}
		if (conflicts.length > 0) {
			return { granted: false, workerId, leases: [], conflicts };
		}

		const leases: FileLease[] = [];
		for (const request of normalizedRequests) {
			const existing = this.#leasesFor(workerId);
			if (request.mode === "write") {
				if (!existing.write.has(request.path)) {
					existing.write.add(request.path);
					this.#writeHolders.set(request.path, workerId);
				}
			} else {
				if (!existing.read.has(request.path)) {
					existing.read.add(request.path);
					let readers = this.#readHolders.get(request.path);
					if (!readers) {
						readers = new Set();
						this.#readHolders.set(request.path, readers);
					}
					readers.add(workerId);
				}
			}
			leases.push({
				path: request.path,
				mode: request.mode,
				workerId,
				acquiredAt: this.#now(),
			});
		}
		return { granted: true, workerId, leases, conflicts: [] };
	}

	/** Release every lease held by one worker. */
	release(workerId: string): void {
		const held = this.#byWorker.get(workerId);
		if (!held) return;
		for (const heldPath of held.write) {
			if (this.#writeHolders.get(heldPath) === workerId) this.#writeHolders.delete(heldPath);
		}
		for (const heldPath of held.read) {
			const readers = this.#readHolders.get(heldPath);
			if (!readers) continue;
			readers.delete(workerId);
			if (readers.size === 0) this.#readHolders.delete(heldPath);
		}
		this.#byWorker.delete(workerId);
	}

	/** Whether `workerId` may currently write `rawPath`. */
	canWrite(workerId: string, rawPath: string): boolean {
		const target = normalizeLeasePath(rawPath, this.#root);
		for (const [heldPath, holder] of this.#writeHolders) {
			if (holder !== workerId && leasePathsConflict(target, heldPath)) {
				return false;
			}
		}
		return true;
	}

	/** The worker holding a conflicting write lease for `rawPath`, if any. */
	writeHolder(rawPath: string): string | undefined {
		const target = normalizeLeasePath(rawPath, this.#root);
		const exact = this.#writeHolders.get(target);
		if (exact !== undefined) return exact;
		for (const [heldPath, holder] of this.#writeHolders) {
			if (leasePathsConflict(target, heldPath)) return holder;
		}
		return undefined;
	}

	/** Number of workers currently holding at least one lease (observability). */
	get holderCount(): number {
		return this.#byWorker.size;
	}

	/** Workers currently holding at least one lease. */
	activeWorkers(): readonly string[] {
		return [...this.#byWorker.keys()];
	}

	#leasesFor(workerId: string): WorkerLeases {
		let held = this.#byWorker.get(workerId);
		if (!held) {
			held = { write: new Set(), read: new Set() };
			this.#byWorker.set(workerId, held);
		}
		return held;
	}
}
