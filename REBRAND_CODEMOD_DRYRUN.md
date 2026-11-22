# REBRAND_CODEMOD — dry run

Generated: 2026-11-22T12:21:03+00:00
Mode: apply

## Values

| Key | Value |
| --- | ----- |
| OLD_SCOPE | @oh-my-pi |
| NEW_SCOPE | @marsai-org |
| OLD_REPO | can1357/oh-my-pi |
| NEW_REPO | MarsAI-org/mars-agent |
| OLD_APP | omp |
| NEW_APP | mars |

## Summary

- files scanned: 11985
- files touched: 12
- total edits: 63
- protected files skipped: 157
- errors: 0

### Edits by category

| Category | Edits |
| -------- | ----- |
| installer-script | 7 |
| repo-url | 1 |
| scope | 55 |

### Excluded on purpose

- `omp://` internal URI scheme (`src/internal-urls/omp-protocol.ts`)
- TUI `role: "omp.*"` render roles
- `__omp_worker_*` argv selectors
- `crates/pi-*` Rust crate names
- LICENSE / THIRD-PARTY-NOTICES / SECURITY.md / lockfiles
- `can1357/oh-my-pi` links that name the upstream project in prose (attribution)

### Per-file detail

#### .omp/skills

- `.omp/skills/tool-prompt-optimization/SKILL.md`
  - scope+package: 2 edit(s)
    - `@oh-my-pi/pi-ai → @marsai-org/ai` ×2
- `.omp/skills/tool-prompt-optimization/scripts/probe-builtin.ts`
  - scope+package: 3 edit(s)
    - `@oh-my-pi/pi-ai → @marsai-org/ai`
    - `@oh-my-pi/pi-coding-agent → @marsai-org/coding-agent` ×2
- `.omp/skills/tool-prompt-optimization/scripts/probe.ts`
  - scope+package: 5 edit(s)
    - `@oh-my-pi/pi-ai → @marsai-org/ai` ×3
    - `@oh-my-pi/pi-catalog → @marsai-org/catalog` ×2

#### .omp/tools

- `.omp/tools/tui.ts`
  - scope+package: 2 edit(s)
    - `@oh-my-pi/pi-natives → @marsai-org/natives`
    - `@oh-my-pi/pi-utils → @marsai-org/utils`

#### crates/natives

- `crates/natives/src/utok/claude/testdata/fixtures.json`
  - scope+package: 10 edit(s)
    - `@oh-my-pi/pi-ai → @marsai-org/ai` ×2
    - `@oh-my-pi/pi-catalog → @marsai-org/catalog`
    - `@oh-my-pi/pi-natives → @marsai-org/natives`
    - `@oh-my-pi/pi-tui → @marsai-org/tui`
    - `@oh-my-pi/pi-utils → @marsai-org/utils` ×5

#### crates/shell

- `crates/shell/src/minimizer/filters/bun.rs`
  - scope+package: 20 edit(s)
    - `@oh-my-pi/pi-coding-agent → @marsai-org/coding-agent` ×9
    - `@oh-my-pi/pi-utils → @marsai-org/utils` ×11

#### packages/coding-agent

- `packages/coding-agent/scripts/omp.ts`
  - scope+package: 1 edit(s)
    - `@oh-my-pi/pi-utils → @marsai-org/utils`
- `packages/coding-agent/src/daemon/modules/predict.ts`
  - scope+package: 2 edit(s)
    - `@oh-my-pi/pi-natives → @marsai-org/natives`
    - `@oh-my-pi/pi-utils → @marsai-org/utils`
- `packages/coding-agent/src/disasm/store.ts`
  - scope+package: 3 edit(s)
    - `@oh-my-pi/pi-tui → @marsai-org/tui` ×2
    - `@oh-my-pi/pi-utils → @marsai-org/utils`
- `packages/coding-agent/src/mcp/host/header-policy.ts`
  - scope+package: 1 edit(s)
    - `@oh-my-pi/pi-utils → @marsai-org/utils`
- `packages/coding-agent/test/tools/disasm-binary.test.ts`
  - scope+package: 6 edit(s)
    - `@oh-my-pi/pi-coding-agent → @marsai-org/coding-agent` ×6

#### scripts/link-omp.sh

- `scripts/link-omp.sh`
  - installer-bin-path: 6 edit(s)
    - `omp → mars` ×6
  - installer-cmd: 1 edit(s)
    - `omp → mars`
  - repo-url: 1 edit(s)
    - `github.com/can1357/oh-my-pi → github.com/MarsAI-org/mars-agent`
