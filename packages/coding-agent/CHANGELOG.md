# Changelog

Mars is developed at [MarsAI-org/mars-agent](https://github.com/MarsAI-org/mars-agent). It is a fork of
oh-my-pi by can1357, which is itself a fork of Pi by Mario Zechner; both upstream projects are MIT
licensed, and their copyright notices are preserved in [LICENSE](./LICENSE) alongside the Mars line.
See [CREDITS.md](./CREDITS.md) for the full lineage. Entries below cover Mars's own changes.

## [Unreleased]

### Added

- **Context window in the custom endpoint flow.** The wizard, `mars login custom`, and `mars models add-provider` gained an optional max-context prompt/`--max-context` flag. An overridden provider gets `providers.contextWindows.<id>` in `config.yml`; a new provider gets a per-model `contextWindow` when its models are declared, or the same setting when the catalog is discovered. `mars config set providers.contextWindows.<id> <tokens>` sets one without the wizard, and a `contextWindow` in `models.yml` still wins.
- **Thinking blocks are hidden until you expand the transcript.** They are out of the way by default; Ctrl+O shows them together with tool output, and the same key hides them again without touching your Ctrl+T preference.
- **`tui.title` setting.** Turn it off to stop mars rewriting the terminal's tab/window title while it runs, leaving the title your shell set in place.

### Changed

- `providers.contextWindows` applies the moment it changes, from `/settings`, `mars config set`, or any in-process write — the catalog is rebuilt like a provider toggle instead of waiting for a restart.
- `config set <record>.<key>` stores the value the argument spells: an object/array or number literal is written as that JSON value, so `config set modelPresets.mine '{"modelRoles":{...}}'` produces a usable preset and `config set providers.maxInFlightRequests.openai 3` stores a number. A malformed object/array argument fails instead of being stored as text.
- `mars models remove-provider` drops the provider's `providers.contextWindows` entry, so a later provider reusing the id does not inherit a window set for the old one. Overwriting a discovered provider with declared models drops it too.
- The HTML export header counts only the conversation the viewer lands on, and reports a provider's own cost total, so a rewound branch or a total-only price no longer inflates `Cost:`/`Tokens:`.

### Fixed

- Raw HTML, `javascript:` links, and non-image `data:` sources in a transcript can no longer execute in the HTML export or the shared session viewer; they render as text.
- A blank entry inside `providers.contextWindows` or `providers.endpoints` is treated as unset instead of failing every command, including the `mars config reset` that would have removed it.
- `grep` says so when the per-file match cap discarded matches, naming the files, instead of letting the caller read a trimmed list as complete.
- A multi-range `read` discloses each range the 3000-line cap cut and names the line to continue from.
- `glob` and `read` stop reporting a result set of exactly `limit` items as truncated, and the archive/table listing notice no longer advises a `limit=` argument `read` does not accept.
- `read` no longer ends each line of a CRLF file with a stray carriage return; `:raw` still returns the bytes verbatim.

## [0.1.7] - 2026-10-23

### Added

- **Custom endpoint wizard in the TUI.** `/login` now lists `+ Custom Endpoint / Provider...` as its last row, and `/endpoint` opens the same wizard directly. It asks whether you are retargeting a built-in provider (writes `providers.endpoints` in `config.yml`, keeping its models and credentials) or registering a new one (writes a `models.yml` block), then collects the URL, wire format, credential, and model list, validating each answer as it goes. `mars login custom` opens the terminal equivalent.

### Changed

- The terminal `mars login` picker gained the same `+ Custom Endpoint / Provider...` row, so an endpoint can be configured without knowing the `mars models add-provider` flags.
- A release version bump no longer rebuilds the native addons. The CI cache key hashes `Cargo.toml`/`Cargo.lock` with workspace versions normalized (`scripts/native_inputs_hash.py`), because the addon's release identity is stamped post-link. Releases previously spent ~38 minutes rebuilding the linux-x64 pair uncached.
- The npm publish gate waits 20 minutes instead of 15. Two ~190 MB native leaves have twice replicated just past the old deadline (v0.1.4 and v0.1.6), failing a release whose packages had in fact published.

## [0.1.6] - 2026-10-22

### Added

- **`providers.endpoints` setting.** A provider → base URL record in `config.yml` retargets any provider, built-in or custom, without editing `models.yml`. It applies to the models' requests and to their model discovery, and can be set per provider with `mars config set providers.endpoints.openai https://my-proxy/v1`. A `baseUrl` pinned for the same provider in `models.yml` still wins.
- **`mars models add-provider`, `remove-provider`, and `providers`.** Add a custom provider interactively or entirely from flags (`--endpoint`, `--api`, `--token`, `--models`, `--discovery`, `--header`), list the custom blocks, and remove one. Edits are spliced into `models.yml` so comments and unrelated keys survive, validated through the real loader before the file is replaced atomically.
- **`mars config get|set|reset` accepts record subkeys**, so a single entry of a record setting can be read or changed without replacing the whole JSON value.

## [0.1.5] - 2026-10-21

### Added

- **Multi-pane orchestrator board (`packages/tui/src/apps/orchestrator-board.ts`).** Displays one live pane per worker with state, task, elapsed time, token count, isolation branch, and output tail. Wide terminals tile panes side by side; narrow terminals show the focused pane full-width with Tab navigation.
- **Worktree isolation for orchestrated workers.** Workers can run with `isolated: true` in their own checkout (worktree or CoW clone), committing to their own temporary branch so parallel edits never collide.
- **The `integrator` bundled agent (`packages/coding-agent/src/prompts/agents/integrator.md`).** Owns the merge phase: cherry-picks completed worker branches onto the target in plan order, resolves conflicts, verifies the combined tree, and cleans up temporary worktrees and branches.
- **Speaker mark, completion glyph, and visible card edges in TUI.** Submitted user prompts open with `❯`, completed tool cards display `✓`, and card borders use visible `frameBorder` (`#484f58` dark, `#a8b1ba` light).
- **Setup progress marks.** Setup wizard displays visual progress marks (`● ● ● ○ ○ ○ ○ 3/7`) instead of plain text.

### Changed

- **The Mars theme is the default.** `theme.dark` was `titanium`, an electric-blue palette, so a fresh install opened in another product's colors and the restyled Mars theme was only reachable through the picker. The setup wizard now offers Mars as the curated dark choice.
- The welcome logo, setup splash, and outro use the Mars ember gradient (`marsDeep → marsEmber → marsOrange → marsGlow`) instead of the inherited magenta/violet/cyan ramp.
- The dark and light status-line tokens resolve through their own palette vars. Dark still carried raw xterm-256 indexes that no other token used.
- Active "Thinking…" label now uses `accent` instead of `muted`.

### Fixed

- `dim` clears 4.5:1 on its own background in both themes (dark 4.12 → 5.07, light 4.36 → 5.02). This also fixes `mdLinkUrl`, `syntaxComment`, and the code-fence border, which alias it.
- `mars completions bash|zsh|fish` no longer emits `_omp`-named shell functions. The generated script defined `_omp`, `_omp_root`, and `complete -F _omp mars` — in a file the user is told to source.
- `config set theme.dark <typo>` is rejected with a clear error instead of printing a success.
- `/theme set` now persists the chosen theme to config instead of only swapping in memory.
- `/theme preview` now reverts to the theme that was previously active instead of hardcoding `dark`.
- `mars toks` sizes its table from the data. The models column was fixed at 22 characters, so `Sonnet/Fable 5+ · Haiku 5.5` pushed its token count out of alignment.
- The release gate polls every package against one deadline instead of giving each a 60-second budget. On v0.1.4 five leaves appeared within seconds and `natives-linux-x64` took four minutes, so the gate failed a release that had published completely.
- CI on `main` now runs on GitHub-hosted runners (`ubuntu-22.04`) instead of unreachable `omp-kata`.
- Android cross-check toolchain channel resolution in CI.
- Mach-O load command parsing replaces missing `llvm-objdump` in cross-target verification.
- Crash handler doc comment rewrapped to satisfy rustfmt.

## [0.1.4] - 2026-10-21

### Added

- **Multi-agent orchestrator is now usable.** `orchestrate` runs a task DAG across worker agents with exclusive file leases, a token budget, and dependency gating. Off by default; enable with `orchestrator.enabled`.
- **Verification gate.** A worker exiting zero is no longer enough: a configured check list runs against its output, and a failing check fails the task and cancels its dependents.

### Fixed

- Native leaf packages publish again. The job depended on the binary smoke tests, so one cancelled macOS runner blocked every leaf and the GitHub Release. It now depends only on the native addon build.
- The release gate no longer reports freshly published packages as missing while npm is still propagating them.

## [0.1.3] - 2026-10-20

### Fixed

- npm installs work for real this time. The native leaf publish job lived in `ci.yml`, which only triggers on branch pushes and pull requests, so a `v*` tag never ran it and no release ever shipped `@marsai-org/natives-<tag>`. The job now lives in `release.yml`, and the GitHub Release is gated on it.

### Added

- `mars` status-line preset: brand mark, active subagents, context pressure, git, and cost in one line.
- `/theme [list|preview|set] [name]`: sample a theme in place with a swatch block before committing.

### Changed

- Dark and light themes rebuilt around the Mars palette (orange `#f97316` on `#0d1117`), replacing the inherited VS Code Dark+ syntax colours with a single warm family.

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
