# Mars Rebrand Report

Comprehensive report on the rebranding from **oh-my-pi** (`omp`) to **Mars** (`mars`), executed on branch `rebrand/mars` targeting repository `MarsAI-org/mars-agent`.

---

## 1. Executive Summary

| Axis | Pre-rebrand | Post-rebrand |
| --- | --- | --- |
| Product name | `oh-my-pi` / `omp` / `pi-coding-agent` | **Mars** |
| CLI command | `omp` | **`mars`** |
| Stats command | `omp-stats` | **`mars-stats`** |
| Release binaries | `omp-<platform>-<arch>` | **`mars-<platform>-<arch>`** |
| npm scope | `@oh-my-pi/*` | **`@marsai-org/*`** |
| GitHub org / repo | `can1357/oh-my-pi` | **`MarsAI-org/mars-agent`** |
| Config directory | `~/.omp` (legacy) | **`~/.mars`** (one-time copy-on-write migration) |
| Project config | `.omp/` | **`.mars/`** |
| Runtime env vars | `OMP_*` | **`MARS_*`** |
| Fallback env vars | `PI_*` | **`PI_*`** (deliberately preserved) |
| License | MIT | **MIT** (Mars copyright appended) |

---

## 2. What Changed by Phase

### Phase 0 — Audit
- Comprehensive inventory grouped by category across the whole repository (`REBRAND_AUDIT.md`).
- Read-only probes resolved target identifiers.

### Phase 1 — Package Identity
- npm scope renamed from `@oh-my-pi/*` to `@marsai-org/*` across `package.json` manifests, workspace imports, and dependencies.
- CLI binary entries renamed to `mars` and `mars-stats`.
- Release binary targets renamed to `mars-<platform>-<arch>`.
- Homebrew formula renderer, Dockerfiles, and CI workflows pointed at Mars.

### Phase 2 — Runtime Paths & Environment Variables
- Runtime env vars renamed from `OMP_*` to `MARS_*` (172 distinct names across 221 files).
- Config dir moved from `~/.omp` to `~/.mars`, with automatic one-time migration (`maybeMigrateLegacyConfigDir`) that copies existing data on first launch without modifying the old directory.
- `APP_NAME = "mars"`, `CONFIG_DIR_NAME = ".mars"` set as single sources of truth in `@marsai-org/utils/dirs`.
- Project config dir renamed from `.omp/` to `.mars/`.
- `PI_*` env vars preserved as-is.

### Phase 3 — UI Text, Prompts & CLI Help
- CLI `--help`, usage strings, sub-command help headers, error messages, and update notices rewritten to `mars` / `Mars`.
- System prompts under `packages/coding-agent/src/prompts/**` updated to name Mars. Prompt instructions, Handlebars logic, RFC keywords, and examples preserved without alteration.
- Model-facing error messages, tips (`tips.txt`), and interactive welcome screens rebranded.
- Test assertion fixtures updated to match the new CLI output.

### Phase 4 — Documentation & Metadata
- Repo-root `README.md` rewritten: architecture, package overview, quick start, installation via GitHub Releases of `MarsAI-org/mars-agent`. All benchmark claims and unmeasured performance numbers removed.
- `CREDITS.md` created with the exact required wording:
  > *Mars is a fork of oh-my-pi by can1357, which is a fork of Pi by Mario Zechner. Both are MIT licensed.*
- `## Credits` section added to `README.md` with identical wording and upstream links.
- Single Mars copyright line appended to `LICENSE` (`Copyright (c) 2026 MarsAI-org`) without altering pre-existing lines or authors.
- Documentation under `docs/` and all package-level `README.md` files rebranded.
- Package descriptions, repository URLs, bug tracker links, and issue templates pointed at `MarsAI-org/mars-agent`.
- `SECURITY.md` updated to direct reports to GitHub private vulnerability reporting.

### Phase 5 — Assets
- `README.md` hero repointed to `assets/mars-logo.png` (a verified flat-gray PNG placeholder carrying an explicit `tEXt` marker — no artwork).
- Vector brand mark placeholder created at `assets/mars-logo.svg`.
- `ASSETS_TODO.md` created, cataloging every location requiring final artwork: README hero, master vector mark, GitHub social preview, collab-web favicon ladder, and TUI wordmark.
- Upstream artwork in `assets/` (`hero.png`, `icon.svg`, and feature screenshots) left untouched on disk.

### Phase 6 — Audit & Verification
- Read-only subagents performed systematic audits across the entire tree:
  - **Audit H**: Verified that all user-facing names, CLI strings, error notices, schemas, and installer scripts were cleanly renamed.
  - **Audit I**: Confirmed LICENSE integrity (original lines intact, exactly one appended line), exact CREDITS wording, and absence of old product names in production code.
  - **Audit J**: Scanned the full diff against `main` for secrets, credentials, machine-specific paths, and unintended email addresses. Clean.
- Built-in binary verified: `mars --version` prints `mars/18.8.6`, `mars --help` displays full CLI help.
- Full workspace checks passed: `bun run check:ts` (16 packages) and `cargo check --workspace --all-targets` (16 crates).

---

## 3. Intentional Leftovers & Justifications

The following tokens remain in the codebase deliberately and must **not** be modified:

| Item | Reason |
| --- | --- |
| `omp://` URI scheme | Internal virtual documentation protocol; referenced across tools and doc files. |
| Role tokens `"omp.<...>"` | Terminal UI rendering roles (`omp.app.title`, `omp.welcome.*`, etc.) consumed by Tern and renderer stylesheets. |
| `__omp_worker_*` argv selectors | Hidden worker dispatch arguments (`cli.ts`), coordinating in-process subprocess spawns. |
| `crates/pi-*` crate names | Cargo crate names (`pi-natives`, `pi-shell`, `pi-ast`, etc.) and internal C-ABI symbols. |
| Original LICENSE text & authors | Upstream copyright notices for Mario Zechner, Can Bölük, and Stencil Labs, Inc. are required by the MIT license. |
| CHANGELOG history | All existing `packages/*/CHANGELOG.md` records prior releases under the original names; past history is immutable. |
| Wire contracts | Protocol values including `ORIGINATOR_CODEX`, gitlab `serverName: "omp"`, `x-omp-*` headers, `application/x-omp-status`, `OMP-Auth-Broker-Capabilities`, `RECORDING_EXTENSION = ".ompcast"`, `header.ompcast`, `--omp-profile-boundary` CLI flag, and `/.well-known/omp-blob-health`. |
| Manifest lookup keys | `pkg.omp ?? pkg.pi` in plugin loaders (`directory-resolution.ts`, `loader.ts`, `manager.ts`) to ensure existing extensions load without modification. |
| Upstream service URLs | `my.omp.sh`, `live.omp.sh`, `qa.omp.sh`, `skills.omp.sh`, and `omp.sh` left with TODO markers pending a domain decision. |
| `PI_*` env vars | Preserved for backwards compatibility with existing tooling and developer setups. |
| `can1357/tap/omp` | Homebrew formula reference left as-is; repointing to an unverified tap would break installation. |
| `sdk/python/omp-rpc` folder name | Folder name preserved to prevent path breakage in build scripts. |

---

## 4. Pending TODOs

1. **Domain Decision**: When an official Mars domain is acquired, repoint:
   - `my.omp.sh` (collab relay and web viewer)
   - `live.omp.sh` (session clip streaming)
   - `qa.omp.sh` (grievance telemetry)
   - `skills.omp.sh` (skillshare registry)
   - `APP_URL` in `packages/utils/src/dirs.ts`
   - Installer one-liners (`omp.sh/install`)
2. **Final Artwork**: Replace `assets/mars-logo.png` and `assets/mars-logo.svg` with production artwork per `ASSETS_TODO.md`.
3. **Homebrew Tap**: Publish a formula under a dedicated tap (e.g. `MarsAI-org/tap`) and update `scripts/ci-update-brew-formula.ts`.
4. **npm Scope Availability**: Verify and publish `@marsai-org/*` packages when ready.
5. **Pre-existing Symlink Guard Weakness**: The symlink check in `assertOwnerPrivateDir` (`packages/coding-agent/src/utils/`) uses `O_NOFOLLOW | O_DIRECTORY`, which does not reliably reject a symlinked final component on all filesystems. Tracked for a dedicated security patch on a separate branch.

---

## 5. Build & Test Verification

- `bun packages/coding-agent/src/cli.ts --version` → **`mars/18.8.6`**
- `bun packages/coding-agent/src/cli.ts --help` → **`mars v18.8.6`**
- `bun run build` → **PASS** (native addon `pi_natives.linux-x64-modern.node` built, client bundles generated).
- `bun run check:ts` → **PASS** (oxfmt + oxlint on 5,870 files, check:types across all 16 packages).
- `cargo check --workspace --all-targets` → **PASS** (16 Rust crates).
- `bun run test` → **186 chunks passed, 16 failed** (matches baseline; all failures are pre-existing environment-dependent tests requiring real TTY/PTY or load-sensitive timeouts).

---

## 6. Commit Chain on `rebrand/mars`

```
47e28a3ad2 fix(rebrand): resolve final residual names across themes, SDKs, and docs
97b6696004 fix(rebrand): resolve residual names from final audit
7eecfa7b7a fix(rebrand): resolve missed test fixtures, installer URLs, and wire values
e9b745750b refactor(rebrand): sweep remaining product-name references to Mars
711b68e625 feat(rebrand): point README hero at mars-logo placeholder, add ASSETS_TODO
deffa23a94 docs(rebrand): rebrand README, docs, and metadata to Mars
17b7b352fe test(rebrand): align assertions with the Mars CLI text
35384c2bff feat(rebrand): rename user-facing CLI text and notices to Mars
7a66a2ec9e docs(rebrand): record Phase 2 completion in the handoff
73b846c732 test(rebrand): expect the Mars help hint in the CLI usage error
a5c3e36b98 test(rebrand): expect the Mars bin name in completion and postmortem output
e28e7ffed2 test(rebrand): align fixtures and assertions with the Mars config dir
247a1f7b0d test(rebrand): align fixtures and assertions with the Mars config dir
abf1c0e71d docs(rebrand): record the Phase 2 outcome and flag the undecided APP_URL host
53ffe2731c fix(rebrand): correct user-facing config-dir paths to ~/.mars
1870b36f6c test(natives): match the Mars XDG app-segment in the loader fixtures
d956107f3a test(mnemopi): match the Mars embeddings User-Agent and title
27e6c435f1 test(ai): match the Mars gateway attribution and User-Agent constants
80f491e24f feat(rebrand): move config dir to ~/.mars with one-time migration
c37818338c feat(rebrand): rename runtime env vars OMP_* to MARS_*
6a166cd3b0 docs: add handoff notes
b39ea0a2e0 test(rebrand): match the npm-registry fixture scope to the renamed package
297de88eb2 style(rebrand): reflow pi-shell bun-output test fixtures after the scope rename
9d321993db chore(rebrand): rename package scope, bins, and binaries to Mars
fb11c699a9 chore(rebrand): phase 0 audit of oh-my-pi -> Mars identifiers
```
