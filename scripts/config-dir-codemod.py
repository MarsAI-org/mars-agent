#!/usr/bin/env python3
"""Phase 2b config-dir codemod — rename the `.mars` config-dir literal to `.mars`.

Usage:
    python3 scripts/config-dir-codemod.py --dry-run     # write CONFIG_DIR_CODEMOD_DRYRUN.md
    python3 scripts/config-dir-codemod.py --apply       # rewrite files in place

Scope decisions (final):
- Rename the on-disk config directory name `.mars` -> `.mars`.
- `.mars` also appears as a provider/source id in prose and comments
  (`native (.mars) and .agents directories`). Those are rewritten too: a path
  segment named `.mars` carries the same name as the directory.
- OMP_* env-var identifiers are NOT touched here (already handled).
- PI_CONFIG_DIR / PI_CODING_AGENT_DIR keep their names and semantics; only the
  default value moves.
- Excluded on purpose:
    * AGENTS.md / HANDOFF.md / REBRAND_*.md (parent owns them)
    * CHANGELOG.md history (immutable)
    * `omp://` scheme and role `omp.*` (not the dir)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys

# Word-boundary `.mars` only as a path segment or a quoted token.
DIR_TOKEN = re.compile(r"(?<![\w.@-])\.mars(?![\w.])")

EXCLUDED_EXACT = {
    "AGENTS.md",
    "HANDOFF.md",
    "REBRAND_AUDIT.md",
    "REBRAND_CODEMOD_DRYRUN.md",
    "ENV_RENAME_MAP.md",
    "ENV_CODEMOD_DRYRUN.md",
    "CONFIG_DIR_CODEMOD_DRYRUN.md",
    "bun.lock",
}

EXCLUDED_BASENAMES = {"CHANGELOG.md"}

EXCLUDED_SUFFIXES = (".zst",)

SKIP_DIRS = {".git", "node_modules", "dist", "target", "binaries", "bazel-out", "__pycache__"}


def _prune_dirs(rel_dir: str, dirnames: list[str]) -> None:
    """Drop generated/foreign trees. `bazel-*` are Bazel's convenience symlinks
    at the repo root only — never real source dirs like
    `.github/actions/bazel-cache/`."""
    keep: list[str] = []
    for name in dirnames:
        if name in SKIP_DIRS:
            continue
        if rel_dir == "." and name.startswith("bazel-"):
            continue
        keep.append(name)
    dirnames[:] = sorted(keep)


def list_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        _prune_dirs(rel_dir, dirnames)
        for name in sorted(filenames):
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            out.append(rel)
    return sorted(out)


def is_excluded(rel: str) -> bool:
    if rel in EXCLUDED_EXACT:
        return True
    if os.path.basename(rel) in EXCLUDED_BASENAMES:
        return True
    if rel.endswith(EXCLUDED_SUFFIXES):
        return True
    return False


def repl(_match: re.Match[str]) -> str:
    return ".mars"


def main() -> int:
    parser = argparse.ArgumentParser(description=".mars -> .mars config-dir codemod")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.dry_run == args.apply:
        print("specify exactly one of --dry-run or --apply", file=sys.stderr)
        return 2

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    files = list_files(root)

    touched: dict[str, str] = {}
    skipped: list[str] = []
    total_edits = 0
    per_file: dict[str, int] = {}

    for rel in files:
        if is_excluded(rel):
            skipped.append(rel)
            continue
        abs_path = os.path.join(root, rel)
        try:
            with open(abs_path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        new_text, count = DIR_TOKEN.subn(repl, text)
        if count:
            touched[rel] = new_text
            total_edits += count
            per_file[rel] = count

    lines: list[str] = []
    lines.append("# CONFIG_DIR_CODEMOD — dry run" if args.dry_run else "# CONFIG_DIR_CODEMOD — applied")
    lines.append("")
    lines.append(f"Generated: {_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}")
    lines.append(f"Mode: {'dry-run' if args.dry_run else 'apply'}")
    lines.append("Rule: `(?<![\\w.@-])\\.mars(?![\\w.])` -> `.mars`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- files scanned: {len(files)}")
    lines.append(f"- files touched: {len(touched)}")
    lines.append(f"- total edits: {total_edits}")
    lines.append(f"- excluded files skipped: {len(skipped)}")
    lines.append("")
    lines.append("### Per-file edit counts")
    lines.append("")
    lines.append("| Edits | File |")
    lines.append("| --- | --- |")
    for rel in sorted(touched, key=lambda r: (-per_file[r], r)):
        lines.append(f"| {per_file[rel]} | `{rel}` |")
    lines.append("")

    report_path = os.path.join(root, "CONFIG_DIR_CODEMOD_DRYRUN.md")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {report_path}")
    print(f"files touched: {len(touched)}, edits: {total_edits}")

    if args.apply:
        for rel, text in touched.items():
            with open(os.path.join(root, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        print(f"applied {len(touched)} file(s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
