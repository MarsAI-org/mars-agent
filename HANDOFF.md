# Mars Project Handoff

This document is the continuous working handoff for engineering sessions across the Mars repositories.

---

## 1. Current State

- **Active branch**: `feat/orchestrator-design` (branched from `main` at commit `6f87d35736`)
- **Remote**: `origin` (`https://github.com/MarsAI-org/mars-agent`, fetch/push)
- **Base branch**: `main` (branch protection enabled; PRs #1, #2, #4, #5, #6 merged)
- **Repo-local Git Identity**: `robomarsx` (`339695250+robomarsx@users.noreply.github.com`)
- **Architecture**:
  - `MarsAI-org/mars-agent`: Core coding agent repository containing packages (`@marsai-org/*`), native addons, CLI binaries, tests, and CI/release workflows.
  - `MarsAI-org/mars-site`: Dedicated website and distribution repository for `getmars.eu.cc`, containing `index.html`, installer scripts (`install`, `install.ps1`), CNAME, GitHub Pages workflow, and installer smoke tests.
- **Upstream Remote**: `upstream` (`https://github.com/can1357/oh-my-pi.git`, read-only fetch).
- **Latest Completed Feature**: Multi-Agent Orchestrator Technical Design & Android/Termux Readiness Audit (DESIGN ONLY).

---

## 2. What Is Done in This Session

1. **System & Platform Audit**:
   - Comprehensive audit of subagent definitions, dynamic ArkType schemas, workpools, worktree isolation backends, and concurrency settings.
   - Comprehensive audit of inter-agent messaging (IRC bus, mailboxes, `agent://` / `history://` / `proc://` schemes), RPC wire schema (`rpc-wire.schema.json`), and subagent subscriptions.
   - Security and permission propagation audit identifying that child subagent permissions must be clamped to parent active tools (`parentActiveTools ∩ requestedChildTools`).
   - Platform audit of binary compilation, Bun runtime dependencies (`bun:sqlite`, `Bun.file`, `Bun.spawn`), native Rust crates (`pi-natives`, `pi-shell`), path resolution (`/bin/sh`, `/tmp`, `searchPaths`), and installer behavior.
2. **Technical Design Document**:
   - Written `ORCHESTRATOR_DESIGN.md` in repository root covering:
     - Goals & Non-Goals (speed first, no fan-out by default, Android/Termux supported).
     - Full system map with verified `file:line` references.
     - Proposed architecture & Mermaid data flow diagram.
     - Core data models (`OrchestratorTask`, `OrchestratorPlan`, `WorkerSpec`, `OrchestratorMessage`, `FileLease`).
     - Decomposition, pre-emptive write lease manager, and two-phase merge/verification pipeline.
     - Fan-out router heuristics and platform-aware defaults.
     - Backend adapter interface (native in-process vs external agent CLIs).
     - Guardrails (budgets, process cap, Termux wake-lock, permission clamping).
     - TUI design: 100+ column desktop grid view and <80 column narrow phone tabbed view.
     - Observability, testing strategy, and benchmark plan.
     - 5-milestone phased roadmap.
     - Dedicated Android/Termux support section (Support Matrix: PRoot-distro Linux ARM64 primary + Remote Client fallback).
     - Comprehensive Autonomous Decision Log (Section 16).
3. **Implementation Next Steps & Ready-to-Paste Prompts**:
   - Written `ORCHESTRATOR_NEXT_STEPS.md` in repository root containing ready-to-paste prompts for Milestone 1 (Core Engine without UI) and Milestone 2 (Termux Feasibility Spike), plus manual mobile device test checklists.

---

## 3. Autonomous Decisions Taken

Full details are recorded in Section 16 of `ORCHESTRATOR_DESIGN.md`:
- **DEC-01 (Concurrency)**: Default max concurrency set to 4 on desktop and 2 on Android/Termux (protecting thermals and the Android 12+ 32 phantom process cap).
- **DEC-02 (File Conflict Prevention)**: Pre-emptive path-based write leases with two-phase verification and commit (prevents wasting tokens on unmergeable work).
- **DEC-03 (Permission Clamping)**: Enforce `child = parent ∩ requested` so child sessions cannot gain tools or looser approval modes than their parent.
- **DEC-04 (Termux Architecture)**: PRoot-distro Linux ARM64 chosen as the primary installation path (standard `linux-arm64` binary runs without Bun engine porting); Remote Client mode as fallback.
- **DEC-05 (Mobile TUI)**: Narrow terminal (<80 cols) falls back to single focused worker view with a tabbed worker switcher strip and touch-friendly single-key navigation.
- **DEC-06 (Format Command Handling)**: Bun was absent on PATH in the audit container; manual verification was used instead of failing `bun run fmt:tools`.
- **DEC-07 (Repo-local Git Identity)**: Configured repo-local `user.name` and `user.email` matching `robomarsx` without modifying global configuration.

---

## 4. How to Build and Run Things

All commands execute from the repository root:

```bash
bun install                  # after a fresh clone
bun run build                # full workspace build
bun run check                # typescript + rust checks
bun run check:tools          # oxlint + oxfmt over packages/* + scripts
bun run check:rs             # cargo fmt --check + clippy -D warnings
bun run fmt:tools            # oxfmt (fixes formatting)
bun run test                 # full TS suite (~202 commands, bucketed)
bun run lint                 # oxlint only
```

*Notes for subsequent sessions:*
- `bunx` is not on PATH in this environment; use `bun run <script>`.
- `npm` is not available; use `bun`.
- Any edit to Rust files requires `cargo fmt --all` prior to `check:rs`.
- Running `bun run check:tools` enforces oxfmt across packages and scripts.

---

## 5. Known Pre-Existing Failing Tests

These fail on `main` and are NOT caused by rebrand or orchestrator work. Do not "fix" them as part of feature branches, and do not treat them as regressions:

| Test file | Area | Why it fails |
| --- | --- | --- |
| `packages/tui/test/glyph-protocol.test.ts` (6 tests) | glyph protocol probe | Terminal-capability probing requires a real TTY; headless CI has none. |
| `packages/tui/test/terminal-info.test.ts` | terminal state | Requires real TTY. Passes in isolation. |
| `packages/tui/test/notifications.test.ts` | OSC 99 notifications | Requires real TTY. |
| `packages/coding-agent/test/fatal-stderr-pty.test.ts` | PTY handoff | Requires a real PTY. |
| `packages/coding-agent/test/utils/changelog-static-import.test.ts` (2) | changelog asset | Requires a compiled-binary bundle context. |
| `packages/coding-agent/test/utils/changelog.test.ts` | changelog PTY smoke | Requires a real PTY. |
| `packages/coding-agent/test/ssh-control-path.test.ts` | `assertOwnerPrivateDir` | Symlinked-directory guard; environment-dependent. |
| `packages/coding-agent/test/runner-cache-restage.test.ts` (2) | `assertOwnerPrivateDir` | Same guard as above. |
| `packages/coding-agent/test/main-initial-message-title.test.ts` | CLI titling | Titling is deferred to the first reply. |
| Bucketed `--parallel=1` flakes (`attachment-chips`, `native/blobs`, `collab/chunked-welcome`, `issue-12281`) | mixed | Load flakes in bucketed runner; pass standalone. |

### Security Note
There is a pre-existing weakness in the symlink guard used by `assertOwnerPrivateDir` (tracked separately; do not touch on feature branches; details held outside repository).

---

## 6. Document Locations & Next Milestones

- **Technical Design Document**: `ORCHESTRATOR_DESIGN.md` (repository root)
- **Next Session Implementation Prompts**: `ORCHESTRATOR_NEXT_STEPS.md` (repository root)
- **Next Milestone**: Milestone 1 ("Core Orchestration Engine without UI")
  - Branch: `feat/orchestrator-core`
  - Ready-to-paste prompt: see `ORCHESTRATOR_NEXT_STEPS.md`

---

## 7. Security Rules That Still Apply

- Work only inside `mars-agent`. Never touch `mars-site`.
- Never read, print, or copy tokens, `~/.config/gh`, `.env` files, SSH keys, or any secret.
- Allowed Git / GH commands: `git status`, `git diff`, `git add`, `git commit`, `git checkout -b`, `git switch`, `git push`, `gh pr create --draft`, `gh pr view`, `gh pr list`.
- Strictly forbidden: `gh auth *`, `gh secret *`, `gh repo delete/edit/transfer/rename`, force push, pushing directly to `main`, git remote mutation, `git config --global`, npm publish/login/token, editing `.opencode/` or `opencode.json`, merging PRs.
- This repo is PUBLIC. Never commit security vulnerability disclosures or unmeasured speed claims.
