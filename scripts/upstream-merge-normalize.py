#!/usr/bin/env python3
"""Normalize rebrand-only conflicts while merging an upstream oh-my-pi tree.

The Mars rebrand is a deterministic token mapping (scripts/rebrand-codemod.py),
so a conflict whose our-side content is exactly `rebrand(base)` carries no
information of its own: upstream's version, rebranded, is the correct
resolution. This script classifies every unmerged path of a merge in progress
and applies that policy, so the human only sees conflicts where both sides
really changed something.

Usage, from the migration worktree:

    git merge main
    python3 scripts/upstream-merge-normalize.py
    git diff --name-only --diff-filter=U     # what still needs a human

Exit status is 0 when every conflict was resolved automatically, 1 when manual
conflicts remain (their paths are also written to the file named by
`--report`, default `/tmp/manual-conflicts.txt`).
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path

CODEMOD = Path(__file__).resolve().parent / "rebrand-codemod.py"


def load_codemod():
    spec = importlib.util.spec_from_file_location("rebrand_codemod", CODEMOD)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {CODEMOD}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rebrand_codemod"] = module
    spec.loader.exec_module(module)
    rules = module.build_rules()
    for rule in rules:
        if rule.rule_id not in module.FUNCTION_REPLACEMENTS:
            module.FUNCTION_REPLACEMENTS[rule.rule_id] = module._make_plain(rule)
    return module, rules


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def blob(rev: str, path: str) -> str | None:
    result = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True)
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "surrogateescape")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="merge-base commit (default: the fork point)")
    parser.add_argument("--ours", default="main", help="our ref (default: main)")
    parser.add_argument("--theirs", default="upstream/main", help="upstream ref")
    parser.add_argument("--report", default="/tmp/manual-conflicts.txt")
    args = parser.parse_args()

    base = args.base or git("merge-base", args.ours, args.theirs).stdout.strip()
    if not base:
        raise SystemExit("cannot determine the merge base; pass --base")

    module, rules = load_codemod()

    def rebrand(path: str, text: str) -> str:
        report = module.Report(generated_at="", mode="normalize", rules=rules)
        return module.apply_rules(path, text, rules, report)

    unmerged = git("diff", "--name-only", "--diff-filter=U").stdout.split()
    stats = {"took upstream": 0, "accepted deletion": 0, "manual": 0}
    manual: list[tuple[str, str]] = []

    for path in unmerged:
        base_text, our_text, their_text = blob(base, path), blob(args.ours, path), blob(args.theirs, path)

        if our_text is None:  # deleted on our side
            if base_text is None or (their_text is not None and rebrand(path, base_text) == their_text):
                git("rm", "-q", "--force", path)
                stats["accepted deletion"] += 1
            else:
                manual.append((path, "deleted here, changed upstream"))
                stats["manual"] += 1
            continue

        if their_text is None:  # deleted upstream
            if base_text is not None and our_text == rebrand(path, base_text):
                git("rm", "-q", "--force", path)
                stats["accepted deletion"] += 1
            else:
                manual.append((path, "deleted upstream, changed here"))
                stats["manual"] += 1
            continue

        if base_text is None:
            manual.append((path, "added on both sides"))
            stats["manual"] += 1
            continue

        if rebrand(path, base_text) == our_text:
            Path(path).write_text(rebrand(path, their_text), encoding="utf-8", errors="surrogateescape")
            git("add", path)
            stats["took upstream"] += 1
            continue

        manual.append((path, "both sides changed content"))
        stats["manual"] += 1

    for key, value in stats.items():
        print(f"{key:<20} {value}")
    Path(args.report).write_text("\n".join(path for path, _ in manual) + ("\n" if manual else ""), encoding="utf-8")
    for path, why in manual[:20]:
        print(f"  {why}: {path}")
    if len(manual) > 20:
        print(f"  ... and {len(manual) - 20} more in {args.report}")
    return 0 if not manual else 1


if __name__ == "__main__":
    sys.exit(main())
