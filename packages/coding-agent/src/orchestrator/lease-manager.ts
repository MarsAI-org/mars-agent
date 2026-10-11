/**
 * File write-lease manager.
 *
 * Workers declare the files they intend to write before they start. A write
 * lease is exclusive: while one worker holds `path` for writing, no other
 * worker may acquire it. Read leases are shared and never conflict with each
 * other or with the holder's own write lease.
 *
 * Acquisition is all-or-nothing so a worker never ends up with a partial lease
 * set that would have to be rolled back mid-run. The orchestrator retries
 * rejected acquisitions when the holder finishes.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md section 5.
 */

import type { FileLease, FileLeaseRequest, FileLeaseResult } from "./types";

/** Per-worker lease bookkeeping. */
interface WorkerLeases {
	write: Set<string>;
	read: Set<string>;
}

export interface LeaseManagerOptions {
	/** Injected clock for deterministic tests. */
	now?: () => number;
}

export class FileLeaseManager {
	readonly #now: () => number;
	readonly #writeHolders = new Map<string, string>();
	readonly #readHolders = new Map<string, Set<string>>();
	readonly #byWorker = new Map<string, WorkerLeases>();

	constructor(options: LeaseManagerOptions = {}) {
		this.#now = options.now ?? (() => Date.now());
	}

	/**
	 * Acquire every requested lease or none of them.
	 *
	 * Write leases are exclusive: while one worker holds `path` for writing, no
	 * other worker may acquire it for writing. Read leases are advisory (each
	 * worker runs in its own checkout, so a reader never observes another
	 * worker's in-flight writes) and never conflict with anything.
	 *
	 * Re-acquiring a lease the same worker already holds succeeds (idempotent),
	 * so a retry loop in the orchestrator never deadlocks on its own holder.
	 */
	acquire(workerId: string, requests: readonly FileLeaseRequest[]): FileLeaseResult {
		const conflicts: FileLease[] = [];
		for (const request of requests) {
			if (request.mode !== "write") continue;
			const holder = this.#writeHolders.get(request.path);
			if (holder !== undefined && holder !== workerId) {
				conflicts.push({ path: request.path, mode: "write", workerId: holder, acquiredAt: this.#now() });
			}
		}
		if (conflicts.length > 0) {
			return { granted: false, workerId, leases: [], conflicts };
		}

		const leases: FileLease[] = [];
		for (const request of requests) {
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
		for (const path of held.write) {
			if (this.#writeHolders.get(path) === workerId) this.#writeHolders.delete(path);
		}
		for (const path of held.read) {
			const readers = this.#readHolders.get(path);
			if (!readers) continue;
			readers.delete(workerId);
			if (readers.size === 0) this.#readHolders.delete(path);
		}
		this.#byWorker.delete(workerId);
	}

	/** Whether `workerId` may currently write `path`. */
	canWrite(workerId: string, path: string): boolean {
		const holder = this.#writeHolders.get(path);
		return holder === undefined || holder === workerId;
	}

	/** The worker holding the write lease for `path`, if any. */
	writeHolder(path: string): string | undefined {
		return this.#writeHolders.get(path);
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
