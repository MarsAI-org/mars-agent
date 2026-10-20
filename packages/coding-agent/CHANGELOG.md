# Changelog

Mars is developed at [MarsAI-org/mars-agent](https://github.com/MarsAI-org/mars-agent). It is a fork of
oh-my-pi by can1357, which is itself a fork of Pi by Mario Zechner; both upstream projects are MIT
licensed, and their copyright notices are preserved in [LICENSE](./LICENSE) alongside the Mars line.
See [CREDITS.md](./CREDITS.md) for the full lineage. Entries below cover Mars's own changes.

## [Unreleased]

## [0.1.2] - 2026-10-20

### Fixed

- npm installs work again. 0.1.1 published the umbrella packages without the six `@marsai-org/natives-<tag>` leaf packages, so `npm i -g @marsai-org/coding-agent` installed cleanly and then failed with "Failed to load pi_natives native addon". The release pipeline now publishes the leaves and refuses to finish a release unless every advertised package resolves on npm.

## [0.1.1] - 2026-10-20

### Changed

- Harness documentation is now addressed as `mars://` in help text, prompts, and generated links; the existing `omp://` spelling keeps working as an alias.
- Web search now tells the agent about its X post operators (`site:x.com`, `from:<handle>`) when you are logged in to xAI, so questions about reactions on X reach X search.
- The default `smol` model now prefers Claude Haiku 5.5 when it is available.
- Automatic session titles now start when the agent's reply begins rather than when you submit, so a slow-thinking first reply gets a card title (icon and code) instead of a plain fallback title.

### Fixed

- Fixed sessions staying untitled when you interrupted the first reply to send a queued steer message.

### Added

- Added the multi-agent orchestrator core (Milestone 1): deterministic scheduling of a task DAG, a dependency-gated task board, exclusive file leases with all-or-nothing acquisition, a fan-out router that stays single-agent by default, child permissions intersected with the parent's active tools, token/request/wall-clock budget guards, a typed agent-to-agent message bus, and a native worker runner. It is opt-in through the `orchestrator.*` settings and disabled by default.
- Added native aarch64 Android/Termux support without PRoot (Milestone 2): a single platform-detection module, shell resolution through `$PREFIX/bin`, an offline `mars --platform-check [--json]` self-check, a POSIX glibc-compatibility launcher, pidfd-based process control on Android, an advisory cross-compile workflow, and Android-aware orchestrator defaults.
- Added the final Mars artwork suite: the master vector mark, the README hero banner, the app icon, the collab-web favicon ladder, and the OpenGraph preview image.
- Added CODEOWNERS for the repository.

### Changed

- Pointed `APP_URL` at `https://getmars.eu.cc/` and added a `MARS_APP_URL` override, so inference-gateway attribution and the installer, schema, SARIF, and package links no longer reference the upstream domain.
- Prepared the npm publish path: `publishConfig.access=public` on all twelve publishable packages, `--dist-tag` and `--pack-only` on the publish script, a token workflow plus an OIDC trusted-publishing workflow, and an operator guide in `NPM_PUBLISH.md`. `CREDITS.md` now ships in every package so the fork lineage travels with the tarball.
- Regenerated the catalog compatibility rules after the rebrand so the committed originator and login strings match the compiler output.

### Fixed

- Fixed a runtime `ReferenceError` in `.mars/tools/tui.ts` caused by leftover `omp.cwd` and `omp.zod` references.
- Fixed residual upstream names in the installer hints, the Z.ai OAuth key name, the HTML-export selectors and theme storage key, and the extension manifest loader, which now also accepts a `mars` key.
- Fixed the publish loop aborting under `bash -e` before it could report the npm error, and moved the credential preflight into an always-on step.
- Fixed the PTY test that read the composer row after the fatal write instead of the painted frame.
- Corrected stale README metrics to the measured values.

## [0.1.0] - 2026-10-10

The first Mars release: the fork is rebranded end to end and ships through its own release pipeline.

### Breaking Changes

- Renamed the npm scope from `@oh-my-pi/*` to `@marsai-org/*`, the CLI from `omp` to `mars`, the stats binary to `mars-stats`, and the release binaries to `mars-<platform>-<arch>`. The legacy `pi-*` compatibility shims still resolve the old specifiers onto the Mars-scope packages.
- Renamed every runtime environment variable from `OMP_*` to `MARS_*` across TypeScript, Rust, Python, Go, shell, CI, Bazel, and the docs. `MARS_PROFILE` is the primary profile selector with `PI_PROFILE` as the legacy fallback, and no `OMP_*` aliases are kept.
- Moved the config and data directory to `~/.mars`. The first read copies `~/.omp` once, staged then renamed into place, and never deletes, moves, or modifies the old directory. `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR` keep their meaning.

### Added

- Added a tag-driven release workflow that builds eight platform binaries, publishes `SHA256SUMS.txt`, and runs a per-platform smoke test. Inherited workflows that pointed at unconfigured services were audited and disabled.

### Changed

- Rebranded the user-facing CLI text, help hints, completion, startup notices, and postmortem output to Mars.
- Rebranded the README, docs, package metadata, and repository URLs to `MarsAI-org/mars-agent`.

### Fixed

- Fixed residual upstream names left in themes, SDKs, test fixtures, installer URLs, and wire values.
