# Android / Termux Runtime Inventory (Tier 3)

This document inventories every Bun-specific runtime dependency in the Mars codebase
to support future Node.js execution on Android/Termux and any Bionic-capable JavaScript
runtime. Counts were produced from a `grep -rE` pass against `packages/*/src` on the
current tree (October 2026) and are marked **VERIFIED (code count)**. Whether any
alternative runtime can satisfy these APIs is **UNVERIFIED** until tested.

## 1. Bun Runtime APIs Used

| API | Call sites in `packages/*/src` | Category |
|---|---|---|
| `Bun.env` | 190 | Process environment; trivially polyfilled by `process.env` |
| `Bun.sleep()` | 158 | Async sleeping; Node equivalent: `setTimeout` promise |
| `Bun.write()` | 152 | Atomic file writes; Node equivalent: `fs.writeFile` |
| `Bun.hash()` | 145 | Fast hashing (xxHash/Wyhash); Node equivalent: `crypto` (slower) |
| `Bun.file()` | 341 | Lazy file handles; Node equivalent: `fs` promises / `fs.open` |
| `Bun.spawn()` | 67 | Process spawning; Node equivalent: `child_process.spawn` |
| `bun:sqlite` | 58 | Embedded SQLite driver; Node equivalent: `node:sqlite`, `better-sqlite3`, or WASM SQLite |
| `import "bun"` shell (`$`) | 49 | Bun Shell; Node equivalent: `execa`, `child_process` |
| `Bun.stringWidth()` | 45 | Terminal text width; Node equivalent: `string-width` (npm) |
| `Bun.JSONL` | 11 | JSONL parsing; Node equivalent: manual streaming `readline` |
| `import.meta.main` | 11 | Entrypoint detection; Node equivalent: `require.main === module` |
| `Bun.which()` | 7 | Executable lookup; Node equivalent: `which` (npm) |
| `Bun.main` | 3 | Entry module path; Node equivalent: `process.argv[1]` |
| `Bun.serve()` | 13 | HTTP server; Node equivalent: `node:http` / `node:https` |
| `Bun.wrapAnsi()` | 3 | ANSI-aware wrapping; Node equivalent: `wrap-ansi` (npm) |
| `Bun.JSON5()` | 1 | JSON5 parsing; Node equivalent: `json5` (npm) |

**Total Bun-specific call sites: 1,254** (categories sum).

## 2. High-Impact Modules Requiring Abstraction

The following areas dominate runtime friction. Each needs an abstraction wrapper
before an alternative runtime can execute the codebase.

### 2.1 `bun:sqlite` (58 sites)
Used by: auth storage (`packages/ai/src/auth/sqlite-credential-store.ts`), memories
(`packages/coding-agent/src/memories/storage.ts`), catalog cache
(`packages/catalog/src/model-cache.ts`), metaharness, stats dashboard.
**Node path**: `node:sqlite` (Node 22+ built-in) or `better-sqlite3` (native addon).
Both require compiled bindings for Bionic, adding a second toolchain.

### 2.2 `Bun.file` / `Bun.write` (493 combined sites)
Used everywhere, including tools, config, VCS wrappers. Most usages are simple
read/write/text, which map cleanly to `fs/promises`. The lazy-file-handle memory
behavior and `.json()`, `.arrayBuffer()`, `.slice()` helpers need a wrapper facade.

### 2.3 `Bun.spawn` / Bun Shell (116 combined sites)
Used by `packages/utils/src/procmgr.ts`, process tree control, eval backends, shell
snapshots. Node `child_process` covers the semantics with more boilerplate.

### 2.4 Native addons
`packages/natives` links a host-specific Rust N-API addon (`pi_natives.linux-x64-modern.node` for AVX2-capable x64 hosts, `-baseline` otherwise; see `packages/natives/src/loader-state.ts`). Node-N-API
interop is compatible, but the addon must be compiled for `aarch64-linux-android`,
which requires the Android NDK.

## 3. Recommended Runtime Abstraction Layer (If Tier 3 Is Pursued)

A thin runtime facade (`packages/utils/src/runtime.ts`) exposing:
- `readFileText(path)`, `writeFileAtomic(path, data)`
- `spawn(argv, options)` returning a promise with `.stdout`, `.exitCode`
- `sleep(ms)`, `hash(input)`, `stringWidth(text)`
- `sqlite.open(path)` backed by `bun:sqlite` or `node:sqlite`

Given the inventory (**1,254 call sites**), a mechanical refactor of all callers is
a multi-week effort with high regression risk across 2,000+ tests. A runtime shim
that patches the globals (`globalThis.Bun = ...`) is a lower-effort path but carries
subtle behavioral differences (file handle laziness, atomic write semantics, error
shapes).

## 4. Decision Record

**DECISION**: Do not pursue Tier 3 runtime portability in Milestone 2. Focus on
Tier 1 (glibc compatibility loader) as the primary native Termux path, and Tier 2
(native Bionic build with any Bionic-capable JS runtime) as the long-term native
target. This document preserves the inventory for future cost estimation.

**Cost estimate (UNVERIFIED)**: a production-grade runtime shim is 2-4 weeks of
work; a full call-site migration is 6-10 weeks plus ongoing maintenance.
