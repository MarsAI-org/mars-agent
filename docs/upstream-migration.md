# Upstream migration status (oh-my-pi → mars-agent)

Upstream is tracked as the `upstream` remote (`https://github.com/can1357/oh-my-pi.git`).
This note records what has been ported, what deliberately has not, and the recipe for
finishing the job, so the measurements are not repeated from scratch.

## Where the trees stand

| Fact                                         | Value                         |
| -------------------------------------------- | ----------------------------- |
| Upstream head when measured                  | `e1a9f4b41d` (version 19.1.0) |
| Fork point (merge-base)                      | `579da1d661`                  |
| Commits behind                               | 12,364 total, 9,263 non-merge |
| Commits ahead (local work)                   | 114                           |
| Files upstream changed since the fork        | 8,733                         |
| Files we never touched that upstream changed | 5,665                         |

## What is applied today

Individual upstream commits that touch only files this repository has never modified
are cherry-picked. The filter is:

```sh
MB=$(git merge-base HEAD upstream/main)
git diff --name-only "$MB"..HEAD | sort -u > /tmp/local-touched.txt   # ours
git log --no-merges --reverse --format='%x01%H %s' --name-only "$MB"..upstream/main |
  # keep commits whose every path exists locally and is untouched locally
```

That yields ~420 of the 9,263 commits (the rest depend on upstream's intervening
refactors in the same files). Of those, 58 applied cleanly. Two were reverted
afterwards because they are only correct as part of a larger upstream change
(`mod keyboard;` without the file, and a cache field that upstream itself dropped).

## Why a merge is not viable yet

- A straight `git merge upstream/main` produces **1,501 conflicted files**.
- Upstream renamed every crate directory: `crates/pi-ast` → `crates/ast`, …, and
  `crates/pi-walker` → `crates/xfs`. Crate package names became `omp-*` while the
  napi addon stays `pi_natives`.
- Path-level file syncing does not work across those renames: importing upstream's
  tree produced 238 unresolvable `mod` targets and dozens of TS errors, because
  siblings live under the renamed directories.
- Normalizing the rebrand removes most conflicts but not all: merging our `main` into
  a rebranded upstream tree gives 1,826 conflicts, of which a script can resolve
  821 automatically (765 "take upstream, rebrand" + 56 deletions). **1,005 need a
  human decision** — they are files we genuinely changed.

## The full migration branch (`migration/upstream-v19`)

The recipe below has been executed end to end on a branch, not on `main`. Upstream
v19.1.0 (12,371 commits ahead of `main`) now sits under this repository's layout and
`bun run check:ts` is green on it.

What the run took, in order:

1. Rebranded upstream's tree with `scripts/rebrand-codemod.py` (5,482 files, 24,096
   edits) and renamed the crate directories and package names back to this
   repository's (`ast`→`pi-ast` … `xfs`→`pi-walker`, `omp-*`→`pi-*`).
2. Merged `main` into it: 1,826 conflicts. `scripts/upstream-merge-normalize.py`
   resolved 821 mechanically (765 "our side is the rebrand of the merge base, take
   upstream rebranded", 56 deletions) and the remaining 1,005 were resolved by hand.
3. Restored the 1,884 upstream-only paths the merge left out (`git checkout
upstream/main --`) and re-ran the codemod on them.
4. Fixed the merge by reading the code, not by trusting either side:
   - our features on files upstream rewrote were ported forward: the H.264 encoder
     fallback, the plugin lockfile migration, the legacy config-root copy, protocol
     handler aliases, the Mars welcome art and the `icon.mars`/`icon.omp` glyph
     aliases, `MARS_LOGO`;
   - the brand constants (`APP_NAME`, `APP_URL`, `CONFIG_DIR_NAME`, `USER_AGENT`,
     log file prefix, `.mars-ready`/`.marscast` markers, installer URLs, root
     `package.json` name and homepage, Docker tags) were reset to this repository's
     values, because upstream's versions leaked `omp` into paths the product writes;
   - the `OMP_*` environment names became `MARS_*` (167 files). The legacy spellings
     stay readable through `LEGACY_ENV_ALIASES`; `parseEnvFile` needed its
     `slice(4)` → `slice("MARS_".length)` fix, which the sweep exposed as
     `PI__FEATURE`.
5. Regenerated the committed glyph bundle (`bun run gen:glyphs`); the merged tree had
   upstream's bundle, keyed by upstream's brand codepoint, next to our font metadata.

### Where it stands

| Gate                      | Result                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `bun run check:ts`        | green (oxlint + every package's `check:types`)                  |
| `bun test packages/utils` | 1,069 pass; the only failures come from the stale native addon  |
| `bun test packages/tui`   | 85 fail against 83 on the pre-merge head, 4,821 tests vs 4,789  |
| Rust (`fmt:rs`)           | clean; `check:rs` not run here (needs the pinned nightly build) |

### Known gaps on that branch

- The napi addon is not rebuilt: the worktree runs with a 0.3.1 `.node` inside a
  19.1.0 tree, which prints a version-mismatch warning and fails the tests that
  assert an empty stderr. `bun run build:native` is required before trusting any
  native-backed result, and it is why the 83 `packages/tui` failures exist on the
  pre-merge head as well.
- Two local tests stay dropped because the feature they cover was replaced by a
  different upstream design: `packages/tui/test/issue-80-resume-bottom-anchored.test.ts`
  (our resume batch) and the composer/transcript accessors it exercised.
- One upstream test genuinely fails on the merged tree:
  `frames that change nothing > skips the write when the body rewrites no row and the
cursor is already parked`. Our TUI writes one frame more than upstream's no-op
  skip expects.
- 35 source comments still link upstream issue numbers (`can1357/oh-my-pi#…`); this
  repository's `main` keeps 30 of the same links, so the counts are at parity.
- Package versions come from upstream (`19.1.0`); `main` stays at `0.3.1` until the
  branch is merged deliberately.

## Recipe for the full migration

1. `git worktree add -b migration/upstream-v19 ../migr upstream/main`
2. Copy `scripts/rebrand-codemod.py` into the worktree and run `--apply` from there
   (the script resolves its root from its own location, so it must live in the tree
   it rewrites).
3. Rename upstream's crate directories back to this repository's names
   (`ast`→`pi-ast`, …, `xfs`→`pi-walker`) and rewrite `omp-<crate>`/`omp_<crate>`
   package names and identifiers to `pi-<crate>`/`pi_<crate>`. `packages/` already
   matches between the two trees, so no TS directory work is needed.
4. `git merge main`, then `python3 scripts/upstream-merge-normalize.py`. It resolves
   every path where our side is exactly the rebrand of the merge base and prints what
   is left.
5. Resolve the remaining conflicts by hand, then gate the result with `bun check`,
   `bun run fmt:rs`, and `bun test`.

Steps 1–4 take minutes; step 5 is the actual work and is why this has not been
attempted as a drive-by change on `main`.

## Verification used for the ported commits

- `bun check` — oxlint, formatting, and every package's `check:types`.
- `bun run fmt:rs` — the pinned nightly's `rustfmt` over all crates.
- `bun test` per package; `packages/tui` has 8 pre-existing failures and
  `packages/natives` has 5 (`DesktopSession`, needs a native build), both present
  before any upstream commit was applied.
