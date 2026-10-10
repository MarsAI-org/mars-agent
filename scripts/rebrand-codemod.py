#!/usr/bin/env python3
"""Rebrand codemod — oh-my-pi (omp) → Mars.

Rule-based, word-boundary codemod for the identity phase (Phase 1) of the
rebrand. NOT blind sed:

  - every rule is an explicit (pattern, replacement, category) triple, so a hit
    inside `pipeline` or `api` can never be rewritten as `mars-peline`;
  - patterns are word-boundary aware (regex lookarounds; `_` and alphanumerics
    count as word characters, so `MARS_` inside a longer token is not matched);
  - each rule carries file-selection guards (path substring / extension);
  - protected content (LICENSE, THIRD-PARTY-NOTICES, .git, vendor trees) is
    excluded by rule, never rewritten;
  - a per-file, per-rule plan is emitted so every diff can be reviewed.

Modes:
    ./scripts/rebrand-codemod.py --plan     # print rule table
    ./scripts/rebrand-codemod.py --dry-run  # write REBRAND_CODEMOD_DRYRUN.md
    ./scripts/rebrand-codemod.py --apply    # rewrite files in place
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Callable

# ---------------------------------------------------------------------------
# Replacement values (Phase 1a detection)
# ---------------------------------------------------------------------------

OLD_SCOPE = "@oh-my-pi"
NEW_SCOPE = "@marsai-org"

OLD_REPO = "can1357/oh-my-pi"
NEW_REPO = "MarsAI-org/mars-agent"

OLD_APP = "omp"
NEW_APP = "mars"

# Published package renames: pi- infix dropped for packages that carried it.
# Folder names stay untouched (packages/ai, packages/catalog, ...).
PACKAGE_RENAMES = {
    "pi-agent-core": "agent-core",
    "pi-ai": "ai",
    "pi-catalog": "catalog",
    "pi-coding-agent": "coding-agent",
    "pi-metaharness": "metaharness",
    "pi-mnemopi": "mnemopi",
    "pi-natives": "natives",
    "pi-tui": "tui",
    "pi-utils": "utils",
    "pi-wire": "wire",
    # already scope-only packages that keep their name
    "browser-relay": "browser-relay",
    "collab-web": "collab-web",
    "omptype": "omptype",
    "snapcompact": "snapcompact",
    "typescript-edit-benchmark": "typescript-edit-benchmark",
}

TEXT_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".json5", ".jsonc",
    ".md", ".yml", ".yaml", ".toml",
    ".sh", ".ps1", ".rb", ".nix",
    ".html", ".css", ".svg", ".kt", ".swift", ".py", ".rs",
    ".ini", ".cfg", ".txt",
    ".gitignore", ".dockerignore", ".bazelrc", ".gitattributes", ".env",
}

SKIP_DIRS = {".git", "node_modules", "dist", "target", "binaries", "bazel-out", "__pycache__"}

PROTECTED_EXACT = {
    "LICENSE",
    "THIRD-PARTY-NOTICES.txt",
    ".github/SECURITY.md",
    "bun.lock",
    "Cargo.lock",
}

# Narrative/history surfaces that later phases own (or that must never be
# rewritten): docs prose, README, contributor guides, and per-package
# CHANGELOG history. The identity codemod stays out of these.
DEFERRED_PATH_MARKERS = (
    "docs/",
    "README.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "CHANGELOG.md",
)


def is_protected(rel: str) -> bool:
    if rel in PROTECTED_EXACT:
        return True
    if rel.startswith(".git/"):
        return True
    if rel.startswith("crates/vendor/"):
        return True
    return False


def is_deferred(rel: str) -> bool:
    if os.path.basename(rel) == "CHANGELOG.md":
        return True
    if os.path.basename(rel) in {"README.md", "REBRAND_AUDIT.md", "REBRAND_CODEMOD_DRYRUN.md", "DEVELOPMENT.md"}:
        return True
    if os.path.basename(rel).endswith("rebrand-codemod.py"):
        return True
    return any(rel == m or rel.startswith(m) for m in DEFERRED_PATH_MARKERS)


@dataclass
class Rule:
    rule_id: str
    category: str
    description: str
    pattern: re.Pattern[str]
    replacement: str
    path_contains: tuple[str, ...] = ()
    extensions: frozenset[str] | None = None
    note: str = ""

    def applies_to(self, rel: str) -> bool:
        if is_protected(rel) or is_deferred(rel):
            return False
        # The internal docs URI scheme stays `omp://` (rule 5 of the task).
        if rel.endswith("src/internal-urls/omp-protocol.ts"):
            return False
        if rel.endswith("src/internal-urls/omp.md"):
            return False
        if self.path_contains and not any(p in rel for p in self.path_contains):
            return False
        if self.extensions is not None:
            if os.path.splitext(rel)[1] not in self.extensions:
                return False
        return True


def esc(text: str) -> str:
    return re.escape(text)


def build_rules() -> list[Rule]:
    rules: list[Rule] = []

    # 1. npm scope + unscoped package name (longest name first so
    #    `pi-coding-agent` never loses to a shorter `pi-` alternative).
    names = sorted(PACKAGE_RENAMES, key=len, reverse=True)
    alternatives = "|".join(esc(n) for n in names)
    rules.append(Rule(
        rule_id="scope+package",
        category="scope",
        description=f"{OLD_SCOPE}/<pkg> → {NEW_SCOPE}/<pkg> (pi- infix dropped, folder names kept)",
        pattern=re.compile(rf"{esc(OLD_SCOPE)}/({alternatives})\b"),
        replacement="",  # handled via function below
        note="imports, package.json deps, catalog pins",
    ))

    # @oh-my-pi/pi-natives-<tag> native-addon leaves
    rules.append(Rule(
        rule_id="scope+natives-leaf",
        category="scope",
        description=f"{OLD_SCOPE}/pi-natives-<tag> → {NEW_SCOPE}/natives-<tag>",
        pattern=re.compile(rf"{esc(OLD_SCOPE)}/pi-natives-([a-z0-9-]+)\b"),
        replacement="",
        note="homebrew/release/npm leaf packages",
    ))

    # @oh-my-pi/omp-stats and its subpaths → @marsai-org/stats
    rules.append(Rule(
        rule_id="scope+omp-stats",
        category="scope",
        description=f"{OLD_SCOPE}/omp-stats[/sub] → {NEW_SCOPE}/stats[/sub]",
        pattern=re.compile(rf"{esc(OLD_SCOPE)}/omp-stats\b"),
        replacement=f"{NEW_SCOPE}/stats",
        note="bin renamed omp-stats → mars-stats",
    ))

    # 2. GitHub org/repo — DISTRIBUTION/METADATA files only. Source comments
    #    that link upstream issues/PRs (`.../issues/8321`) are intentional
    #    upstream references and are left untouched.
    distribution_paths = (
        "package.json",
        "Cargo.toml",
        ".github/",
        "scripts/install.sh",
        "scripts/install.ps1",
        "scripts/link-omp.sh",
        "scripts/setup.ts",
        "scripts/setup-npm-trust.ts",
        "scripts/ci-release",
        "scripts/ci-update-brew-formula.ts",
        "scripts/ci-macos",
        "Dockerfile",
        ".dockerignore",
        "flake.nix",
        "nix/",
        "packages/coding-agent/src/cli/update-cli.ts",
    )
    rules.append(Rule(
        rule_id="repo-url",
        category="repo-url",
        description=f"github.com/{OLD_REPO} → github.com/{NEW_REPO}",
        pattern=re.compile(rf"github\.com/{esc(OLD_REPO)}\b"),
        replacement=f"github.com/{NEW_REPO}",
        path_contains=distribution_paths,
        note="metadata/CI/distribution only; upstream issue links preserved",
    ))
    rules.append(Rule(
        rule_id="repo-owner-slash",
        category="repo-url",
        description=f"bare {OLD_REPO} → {NEW_REPO} (install/release scripts)",
        pattern=re.compile(rf"(?<![A-Za-z0-9@/._-]){esc(OLD_REPO)}(?![A-Za-z0-9._-])"),
        replacement=NEW_REPO,
        path_contains=distribution_paths,
        note="REPO/git URLs in installers, CI, release tooling",
    ))
    # NOTE: `can1357/tap/omp` (an upstream-owned Homebrew tap) is NOT rewritten
    # here — handled manually with a TODO; repointing it to a non-existent tap
    # would break `brew install`. Upstream attribution links keep the old owner.

    # 3. Distribution binary asset names: omp-<platform>-<arch>
    rules.append(Rule(
        rule_id="binary-asset",
        category="binary-asset",
        description="omp-<platform>-<arch> → mars-<platform>-<arch>",
        pattern=re.compile(r"\bomp-(darwin|linux|windows|macos)[a-z0-9-]*\b"),
        replacement="",  # function-style below
        note="release targets, homebrew formula, installers",
    ))

    # 4. Installer scripts: command name in quoted/whitespace-delimited form
    rules.append(Rule(
        rule_id="installer-cmd",
        category="installer-script",
        description="command name `omp` → `mars`",
        pattern=re.compile(r"(?<![\w./@-])omp(?![\w./@-])"),
        replacement=NEW_APP,
        path_contains=("scripts/install.sh", "scripts/install.ps1", "scripts/link-omp.sh", "scripts/setup.ts"),
        note="installers/link script only",
    ))
    rules.append(Rule(
        rule_id="installer-bin-path",
        category="installer-script",
        description="/bin/omp → /bin/mars",
        pattern=re.compile(r"(?<=/)omp\b"),
        replacement=NEW_APP,
        path_contains=("scripts/install.sh", "scripts/install.ps1", "scripts/link-omp.sh", "scripts/setup.ts"),
        note="binary install destination path",
    ))

    # 5. Nix flake attributes
    rules.append(Rule(
        rule_id="nix-attr",
        category="nix",
        description="nix attribute/package `omp` → `mars`",
        pattern=re.compile(r"(?<![\w./@-])omp(?![\w./@-])"),
        replacement=NEW_APP,
        path_contains=("flake.nix", "nix/"),
        note="homeManagerModules.omp etc.",
    ))

    # 6. Docker image tags
    rules.append(Rule(
        rule_id="docker-name",
        category="docker",
        description="docker image/tag `omp`/`oh-my-pi/pi` → `mars`/`mars/agent`",
        pattern=re.compile(r"(?<![\w./@-])omp(?![-\w./])"),
        replacement=NEW_APP,
        path_contains=("Dockerfile", ".dockerignore"),
        note="Dockerfile*, dockerignore",
    ))
    rules.append(Rule(
        rule_id="docker-image-repo",
        category="docker",
        description="oh-my-pi/pi → mars/agent",
        pattern=re.compile(r"oh-my-pi/pi\b"),
        replacement="mars/agent",
        path_contains=("Dockerfile", ".dockerignore"),
        note="Dockerfile*, dockerignore",
    ))

    # 7. Bazel convenience symlink
    rules.append(Rule(
        rule_id="bazel-symlink",
        category="bazel",
        description="bazel-oh-my-pi → bazel-mars",
        pattern=re.compile(r"bazel-oh-my-pi"),
        replacement="bazel-mars",
        path_contains=(".gitignore", "bunfig.toml", "MODULE.bazel", "BUILD.bazel"),
    ))

    # 8. Prose brand word — intentionally NOT part of Phase 1. Docs prose,
    #    README, AGENTS/CONTRIBUTING, prompts and UI strings belong to phases
    #    3 and 4, where each string is reviewed individually rather than
    #    rewritten by token.

    return rules


# ---------------------------------------------------------------------------
# Function-style replacements
# ---------------------------------------------------------------------------

def replace_scope_package(match: re.Match[str]) -> str:
    return f"{NEW_SCOPE}/{PACKAGE_RENAMES[match.group(1)]}"


def replace_natives_leaf(match: re.Match[str]) -> str:
    return f"{NEW_SCOPE}/natives-{match.group(1)}"


def replace_binary_asset(match: re.Match[str]) -> str:
    """`omp-<platform>[-<arch>]` → `mars-<platform>[-<arch>]` (arch preserved)."""
    return "mars-" + match.group(0)[len("omp-"):]

FUNCTION_REPLACEMENTS: dict[str, Callable[[re.Match[str]], str]] = {
    "scope+package": replace_scope_package,
    "scope+natives-leaf": replace_natives_leaf,
    "binary-asset": replace_binary_asset,
}


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

@dataclass
class Edit:
    rule_id: str
    category: str
    file: str
    line: int
    before: str
    after: str


@dataclass
class Report:
    generated_at: str
    mode: str
    rules: list[Rule]
    edits: list[Edit] = field(default_factory=list)
    files_touched: list[str] = field(default_factory=list)
    protected_skipped: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def list_workspace_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root)
            ext = os.path.splitext(name)[1]
            tail = name.rsplit(".", 1)[-1] if "." in name else ""
            if ext in TEXT_EXTENSIONS or f".{tail}" in TEXT_EXTENSIONS or name in {".gitignore", ".dockerignore", ".env", ".bazelrc", ".gitattributes"}:
                out.append(rel.replace(os.sep, "/"))
    return sorted(out)


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def apply_rules(rel: str, text: str, rules: list[Rule], report: Report) -> str:
    for rule in rules:
        if not rule.applies_to(rel):
            continue
        fn = FUNCTION_REPLACEMENTS.get(rule.rule_id)
        out: list[str] = []
        pos = 0
        for match in rule.pattern.finditer(text):
            after = fn(match)
            if after == match.group(0):
                continue
            report.edits.append(Edit(
                rule_id=rule.rule_id,
                category=rule.category,
                file=rel,
                line=line_of(text, match.start()),
                before=match.group(0),
                after=after,
            ))
            out.append(text[pos:match.start()])
            out.append(after)
            pos = match.end()
        if pos == 0:
            continue
        out.append(text[pos:])
        text = "".join(out)
    return text


def _make_plain(rule: Rule):
    """Build the callable for a rule whose replacement is a fixed string."""

    def _repl(_match: re.Match[str]) -> str:
        return rule.replacement

    return _repl


def main() -> int:
    parser = argparse.ArgumentParser(description="oh-my-pi → Mars rebrand codemod")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    rules = build_rules()
    # Wire a callable for every plain-string rule; captured by rule_id so
    # `apply_rules` doesn't need to know which rules use functions.
    for rule in rules:
        if rule.rule_id not in FUNCTION_REPLACEMENTS:
            FUNCTION_REPLACEMENTS[rule.rule_id] = _make_plain(rule)

    if args.plan:
        for rule in rules:
            guard = " ".join(filter(None, [
                ("paths:" + ",".join(rule.path_contains)) if rule.path_contains else "",
            ]))
            print(f"{rule.rule_id:<24} {rule.category:<16} {rule.description}")
            if guard:
                print(f"{'':<24} {'':<16} {guard}")
        return 0

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    files = list_workspace_files(root)
    report = Report(
        generated_at=_dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        mode="apply" if args.apply else "dry-run",
        rules=rules,
        protected_skipped=[f for f in files if is_protected(f)],
    )

    new_texts: dict[str, str] = {}
    for rel in files:
        if is_protected(rel):
            continue
        abs_path = os.path.join(root, rel)
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as error:
            report.errors.append(f"read {rel}: {error}")
            continue
        out = apply_rules(rel, text, rules, report)
        if out != text:
            new_texts[rel] = out
            report.files_touched.append(rel)

    report.files_touched.sort()

    # ---- report file ------------------------------------------------------
    lines: list[str] = []
    lines.append("# REBRAND_CODEMOD — dry run")
    lines.append("")
    lines.append(f"Generated: {report.generated_at}")
    lines.append(f"Mode: {report.mode}")
    lines.append("")
    lines.append("## Values")
    lines.append("")
    lines.append("| Key | Value |")
    lines.append("| --- | ----- |")
    for key, value in (
        ("OLD_SCOPE", OLD_SCOPE),
        ("NEW_SCOPE", NEW_SCOPE),
        ("OLD_REPO", OLD_REPO),
        ("NEW_REPO", NEW_REPO),
        ("OLD_APP", OLD_APP),
        ("NEW_APP", NEW_APP),
    ):
        lines.append(f"| {key} | {value} |")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- files scanned: {len(files)}")
    lines.append(f"- files touched: {len(report.files_touched)}")
    lines.append(f"- total edits: {len(report.edits)}")
    lines.append(f"- protected files skipped: {len(report.protected_skipped)}")
    lines.append(f"- errors: {len(report.errors)}")
    lines.append("")
    lines.append("### Edits by category")
    lines.append("")
    counts: dict[str, int] = {}
    for edit in report.edits:
        counts[edit.category] = counts.get(edit.category, 0) + 1
    lines.append("| Category | Edits |")
    lines.append("| -------- | ----- |")
    for cat in sorted(counts):
        lines.append(f"| {cat} | {counts[cat]} |")
    lines.append("")
    lines.append("### Excluded on purpose")
    lines.append("")
    lines.append("- `omp://` internal URI scheme (`src/internal-urls/omp-protocol.ts`)")
    lines.append("- TUI `role: \"omp.*\"` render roles")
    lines.append("- `__omp_worker_*` argv selectors")
    lines.append("- `crates/pi-*` Rust crate names")
    lines.append("- LICENSE / THIRD-PARTY-NOTICES / SECURITY.md / lockfiles")
    lines.append("- `can1357/oh-my-pi` links that name the upstream project in prose (attribution)")
    lines.append("")
    lines.append("### Per-file detail")
    lines.append("")

    by_file: dict[str, dict[str, dict[str, int]]] = {}
    for edit in report.edits:
        per_file = by_file.setdefault(edit.file, {})
        per_rule = per_file.setdefault(edit.rule_id, {})
        pair = f"{edit.before} → {edit.after}"
        per_rule[pair] = per_rule.get(pair, 0) + 1

    groups: dict[str, list[str]] = {}
    for rel in report.files_touched:
        key = "/".join(rel.split("/")[:2])
        groups.setdefault(key, []).append(rel)

    for group in sorted(groups):
        lines.append(f"#### {group}")
        lines.append("")
        for rel in sorted(groups[group]):
            lines.append(f"- `{rel}`")
            for rule_id, pairs in sorted(by_file[rel].items()):
                total = sum(pairs.values())
                lines.append(f"  - {rule_id}: {total} edit(s)")
                for pair, n in sorted(pairs.items()):
                    suffix = f" ×{n}" if n > 1 else ""
                    lines.append(f"    - `{pair}`{suffix}")
        lines.append("")

    if report.errors:
        lines.append("### Errors")
        lines.append("")
        for err in report.errors[:50]:
            lines.append(f"- {err}")
        lines.append("")

    out_path = os.path.join(root, "REBRAND_CODEMOD_DRYRUN.md")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {out_path}")
    print(f"files touched: {len(report.files_touched)}, edits: {len(report.edits)}, errors: {len(report.errors)}")

    if args.apply:
        for rel, text in new_texts.items():
            with open(os.path.join(root, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        print(f"applied {len(new_texts)} file(s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
