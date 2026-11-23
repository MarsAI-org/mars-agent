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

## Periodic sync check

`.github/workflows/upstream-sync-check.yml` runs weekly (Monday 06:00 UTC) and on manual
`workflow_dispatch` to fetch `can1357/oh-my-pi`, measure drift against `main`, list clean
cherry-pickable commits touching only locally-untouched files, and publish a summary (plus an
optional tracking digest issue) without mutating `main`.

## Verification used for the ported commits

- `bun check` — oxlint, formatting, and every package's `check:types`.
- `bun run fmt:rs` — the pinned nightly's `rustfmt` over all crates.
- `bun test` per package; `packages/tui` has 8 pre-existing failures and
  `packages/natives` has 5 (`DesktopSession`, needs a native build), both present
  before any upstream commit was applied.
