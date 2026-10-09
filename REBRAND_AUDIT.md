# REBRAND_AUDIT — oh-my-pi → Mars

Phase 0 audit of every old-brand occurrence in this repo (`/root/mars-agent`).
Branch: `rebrand/mars`. No source edits made yet; this file is the only new artifact.

Scope of the three identifiers we scan for: `omp` (word-boundary), `oh-my-pi`
(`@oh-my-pi` / `oh-my-pi`), and `pi` where it is user- or distribution-facing.
`PI_*` env vars, `pi-` crate/package names, and `pi://`-family URI schemes are
included as findings but flagged where renaming is likely unsafe (see §8).

## Headline counts (tracked files, excludes `.git`, `bun.lock`)

| Token         | Occurrences | Files  |
| ------------- | ----------- | ------ |
| `@oh-my-pi`   | 19,319      | 4,512  |
| `oh-my-pi`    | 21,040      | 4,653  |
| `pi-coding-agent` | 6,497   | 1,523  |
| `omp` (word)  | —           | 1,884  |
| `omp.sh` URLs | 185         | 83     |
| `OMP_` (env)  | 1,400       | 275    |
| `PI_` (env)   | 4,759       | 844    |
| `my.omp.sh`   | 59          | 17     |
| `Oh My Pi`    | 0           | 0      |

Repository: 8,828 tracked files.

Note: `@oh-my-pi` + `oh-my-pi` totals are dominated by TypeScript import
specifiers (`import ... from "@oh-my-pi/pi-utils"`). These are the single
largest mechanical class and are fully addressed by the npm-scope rename.

---

## 1. Package names & npm scope  (Phase 1)

Root `package.json`: `"name": "omp"`, and `catalog` pins `@oh-my-pi/*@18.8.6`.

| Path | Current name | New name |
| ---- | ------------ | -------- |
| root | `omp` | `mars` |
| packages/agent | `@oh-my-pi/pi-agent-core` | `@SCOPE/agent-core` |
| packages/ai | `@oh-my-pi/pi-ai` | `@SCOPE/ai` |
| packages/browser-relay | `@oh-my-pi/browser-relay` | `@SCOPE/browser-relay` |
| packages/catalog | `@oh-my-pi/pi-catalog` | `@SCOPE/catalog` |
| packages/coding-agent | `@oh-my-pi/pi-coding-agent` | `@SCOPE/coding-agent` |
| packages/collab-web | `@oh-my-pi/collab-web` | `@SCOPE/collab-web` |
| packages/metaharness | `@oh-my-pi/pi-metaharness` | `@SCOPE/metaharness` |
| packages/mnemopi | `@oh-my-pi/pi-mnemopi` | `@SCOPE/mnemopi` |
| packages/natives | `@oh-my-pi/pi-natives` | `@SCOPE/natives` |
| packages/omptype | `@oh-my-pi/omptype` | `@SCOPE/omptype` |
| packages/snapcompact | `@oh-my-pi/snapcompact` | `@SCOPE/snapcompact` |
| packages/stats | `@oh-my-pi/omp-stats` | `@SCOPE/stats` |
| packages/tui | `@oh-my-pi/pi-tui` | `@SCOPE/tui` |
| packages/typescript-edit-benchmark | `@oh-my-pi/typescript-edit-benchmark` | `@SCOPE/typescript-edit-benchmark` |
| packages/utils | `@oh-my-pi/pi-utils` | `@SCOPE/utils` |
| packages/wire | `@oh-my-pi/pi-wire` | `@SCOPE/wire` |

Native addon leaf packages: `@oh-my-pi/pi-natives-<tag>` (generated in
`scripts/setup-npm-trust.ts`, `scripts/ci-release-publish.ts`, consumed in
`.github/workflows/ci.yml`).

DECISION NEEDED: the new scope name (`MARS_NPM_SCOPE`) — see §9 open questions.
`@oh-my-pi/pi-*` → suggested `@<scope>/<name>` (drop the `pi-` infix). All
package directories keep their current folder names unless we also rename dirs
(a larger, optional change — recommend keeping dirs to minimize churn).

## 2. Bin entries / CLI command  (Phase 1)

| File | Current bin | New bin |
| ---- | ----------- | ------- |
| packages/coding-agent/package.json | `omp` → `src/cli.ts` | `mars` |
| packages/stats/package.json | `omp-stats` → `./src/index.ts` | `mars-stats` |
| packages/mnemopi/package.json | `mnemopi` (no brand) | keep |
| packages/metaharness/package.json | `metaharness` (no brand) | keep |

Compiled binary naming — `scripts/ci-release-build-binaries.ts` builds
`omp-<platform>-<arch>` (8 targets) and `scripts/ci-release-build-binaries.test.ts`
asserts those exact names. Homebrew formula (`scripts/ci-update-brew-formula.ts`)
downloads `omp-<platform>-<arch>` and installs `=> "omp"`. These must move to
`mars-*`.

## 3. Docs, UI strings, prompts  (Phase 3 / Phase 4)

- `packages/coding-agent/src/cli/help-extra.ts`, `cli.ts`, `commands/launch-help.ts`
  — help text using `omp`, `Usage: omp ...`, `~/.omp/...` examples.
- Sub-CLI usage strings: `auth-broker-cli.ts`, `skill-cli.ts` (`SKILL_USAGE`),
  `ssh-cli.ts`, `commands/install.ts`, `stencil/credential.ts`, `config-cli.ts`,
  `browser-relay-cli.ts`, `profile-alias.ts`, `profile-bootstrap.ts`,
  `cli-commands.ts`, `flag-tables.ts`.
- System/user-facing prompts: `packages/coding-agent/src/prompts/**`
  (`system/system-prompt.md`: "You are omp's trusted coding assistant.";
  `internal-urls/*.md`, `tools/*.md` reference `~/.omp/...`, `.omp/...`,
  `omp ps`, `omp worktree`, `omp config`).
- TUI role/label strings: 373 distinct `"omp.<...>"` role tokens
  (e.g. `omp.picker.title`, `omp.tool.stats`, `omp.app.title`) in
  `packages/tui/src` and `packages/coding-agent/src`. These are internal render
  role identifiers — see §8 for the rename-safety call.
- `packages/tui/src/setup/scenes/*` comments ("omp's own composer chrome").
- ASCII/wordmark: no literal ASCII-art logo banner found; the wordmark appears
  via `APP_NAME` and README hero image. `assets/icon.svg` is a Pi-symbol art.

## 4. Config / data directory  (Phase 2)

Canonical definition: `packages/utils/src/dirs.ts`

- `APP_NAME = "omp"`
- `CONFIG_DIR_NAME = ".omp"`  ← the config/data dir name
- `APP_URL = "https://omp.sh/"`
- `USER_AGENT = "omp/${VERSION}"`  (sent to providers; branded traffic header)
- Config root resolution: `~/.omp`, `~/.omp/agent`, `~/.omp/profiles/<name>`,
  plus XDG redirects under `$XDG_*_HOME/omp/`.

Consumers / literals of `.omp`: `config.ts`, `discovery/omp-extension-roots.ts`,
`extensibility/extensions/loader.ts`, `ratchet/ratchet.ts`, `secrets/index.ts`,
`task/discovery.ts`, `tools/browser/storage-state.ts`, `cli/agents-cli.ts`,
`advisor/watchdog.ts`, plus `.pi` legacy fallbacks. Repo-local `.omp/` dir
(commands/skills/tools) is project config read by the agent — renaming it is a
behavioral change, see §8.

Docs referencing `~/.omp`: `docs/config-usage.md`, `docs/environment-variables.md`
and most of `docs/*.md`.

Migration: `docs/environment-variables.md` documents a `omp config migrate`
(XDG) flow; we add a `.omp → .mars` copy-once migration (never delete old).
Note: `agent-storage-model-perf.test.ts` sets `PI_CONFIG_DIR: ".omp"`
explicitly — tests will need the new default.

## 5. Environment variables  (Phase 2)

- Prefix `OMP_*`: 172 distinct names (`OMP_PROFILE`, `OMP_AGENT_DIR`,
  `OMP_AUTH_BROKER_*`, `OMP_BENCH_*`, `OMP_LOG_LEVEL`, `OMP_REPO`, ...).
- Prefix `PI_*`: 231 distinct names; many are runtime knobs
  (`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `PI_*` feature flags).
- Existing aliasing pattern already in code: `OMP_PROFILE` canonical with
  `PI_PROFILE` legacy fallback (`resolveProfileEnv`); `.env` mirroring maps
  every `OMP_*` to its `PI_*` alias.

DECISION NEEDED: whether `MARS_*` replaces `OMP_*` only (keep `PI_*` as legacy
aliases) or both. Consumer vars like `ANTHROPIC_API_KEY` are untouched.
Recommend: `MARS_*` canonical, keep `OMP_*` (and `PI_*`) as accepted legacy
aliases for one release.

## 6. URLs, CI/CD, release, distribution  (Phase 4 / Phase 6)

- Domain `omp.sh`: 185 hits / 83 files. Subdomains: `my.omp.sh` (hosted UI),
  `live.omp.sh`, `qa.omp.sh`, `omp.sh/install`, `omp.sh/install.ps1`,
  `omp.sh/schemas/rpc-wire.json`, `omp.sh/x`.
- GitHub `can1357/oh-my-pi`: ~hundreds incl. install scripts
  (`scripts/install.sh`, `install.ps1`), `update-cli.ts` (`REPO`,
  `PACKAGE`, `MISE_TOOL=github:can1357/oh-my-pi`), `ci-release-notes.ts`,
  `ci-update-brew-formula.ts`, `setup-npm-trust.ts`, Cargo.toml `repository`,
  every `package.json` `repository`/`bugs`/`homepage`.
- `.github/`: workflows (`ci.yml`, `bun-cache-warm.yml`, `nix.yml`),
  `ISSUE_TEMPLATE/*.yml` (contact links), `SECURITY.md`, actions.
- Bazel symlink `bazel-oh-my-pi` (`.gitignore`, `bunfig.toml`).
- Docker images/tags `oh-my-pi/pi:dev`, `pi-base` (Dockerfile,
  Dockerfile.robomp, dockerignores).
- Nix flake + `nix/`, `infra/`, `python/robomp/`.
- Issue/PR links to `can1357/oh-my-pi` in docs and code comments: these are
  intentional upstream references (history) — keep, per §7 of the rules.

## 7. Assets / images  (Phase 5)

- `assets/hero.png` (README hero), `assets/icon.svg` (Pi-symbol SVG),
  plus feature `.webp` screenshots (not brand art).
- README hero `<img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png">`.
- No in-terminal ASCII wordmark asset found.
- Phase 5: add `assets/mars-logo.*` placeholders and point paths there; list
  every spot needing final artwork.

## 8. Rename-safety flags (will confirm before touching)

These appear brand-like but the rules (§5 of the task: "do not rename internal
URI schemes or core internal APIs") may protect them. Flagging for your call:

- `omp://` internal URI scheme (`internal-urls/omp-protocol.ts`, and
  `prompts/internal-urls/omp.md`). Looks user-visible (`omp://docs`) but is a
  protocol identifier. Rule §5 lists `pr:// issue:// agent:// skill:// rule://
  conflict://` as protected; `omp://` is not in that list but is the same class.
  RECOMMEND: leave `omp://` as-is (internal scheme) unless you say otherwise.
- TUI `role: "omp.*"` tokens (373) — internal render/theme roles. RECOMMEND:
  leave as-is (not user-facing), or rename only if they surface in output.
- `__omp_worker_*` argv selectors and `omp.ida.<id>` daemon/perf names — internal.
- Repo-local `.omp/` directory — the agent's project-config dir name derived
  from `CONFIG_DIR_NAME`; renaming changes where project commands/skills load.
- `~/.omp` home dir — Phase 2 target (user-facing), but ensure `.pi` legacy
  fallbacks still read.
- Rust crates `crates/pi-*` and workspace members — internal crate names; rule
  §5 suggests keeping core internals. RECOMMEND: keep crate names, rename only
  the packaged `@scope/natives` JS surface.
- `pi-mono` / `Pi` references in docs about the upstream lineage — keep where
  they describe history (CREDITS/README credits).

## 9. Open questions (please confirm before Phase 1)

1. npm scope (`MARS_NPM_SCOPE`): `@mars`? `@mars-agent`? something else — you
   used `@[MARS_NPM_SCOPE]` as a placeholder.
2. GitHub org/repo (`[MARS_GITHUB_ORG]/[REPO_NAME]`): value?
3. Domain (`[MARS_DOMAIN]`): value, or leave TODO (we never invent URLs)?
4. Env vars: `MARS_*` only, or also move `PI_*` (231 names) → keep `PI_*` as
   legacy aliases?
5. Package directory names: keep `packages/pi-*` folder names (only rename npm
   names), or rename folders too?
6. §8 items — confirm leave-as-is, or rename any?

## Suggested phase order & risk

1. Scope/packages/bin (`@oh-my-pi` imports = 4.5k files, mechanical + codemod).
2. Config dir `.omp`→`.mars` + `MARS_*` env + migration.
3. UI/help/prompt strings.
4. README/docs/metadata/repo fields/CI.
5. Assets placeholders.
6. Final sweep + PR.

Biggest risk: the 4.5k-file `@oh-my-pi` import rename and the 8k-file word
`omp` sweep — must be driven by word-boundary codemods with per-category
review, never blind substring replace.

## 10. Phase 2 status (recorded at completion)

- Env vars: every `OMP_*` became `MARS_*` (word-boundary codemod, no `OMP_*`
  fallback aliases). `PI_*` untouched. `MARS_PROFILE` is the primary profile
  selector with `PI_PROFILE` kept as the legacy fallback (`resolveProfileEnv`);
  the `.env` mirror still maps `MARS_*` to the matching `PI_*` alias.
- Config dir: `~/.omp` → `~/.mars` (user root, `agent/`, `profiles/<name>/`, and
  the XDG segment `$XDG_*_HOME/mars/`). `APP_NAME = "mars"`,
  `CONFIG_DIR_NAME = ".mars"`, `USER_AGENT = "mars/<version>"`.
- Migration: a one-time copy-once move from `~/.omp` to `~/.mars` when the old
  dir exists and the new one does not. The old directory is never deleted or
  modified. One short English notice is emitted by the process that performs it.
- `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` keep their names and semantics; only
  the default value moved. No `.pi` directory probe was added — the `.pi`
  support that exists is env-var based plus `pi.extensions` manifest keys.
- Repo-local `.omp/` project config was renamed to `.mars/` (see §8: this is a
  deliberate behavioral change).
- Still pre-rebrand on purpose: `APP_URL` (no Mars domain decided yet — see the
  TODO in `packages/utils/src/dirs.ts`), `my.omp.sh` and friends, the codex
  `originator` wire contract, `omp://`, role `omp.*` tokens,
  `__omp_worker_*` argv selectors, `crates/pi-*` names, package folder names,
  and every CHANGELOG history entry.
