#!/usr/bin/env python3
"""Compute a content-addressed SHA256 hash of native build inputs.

Used by CI (.github/workflows/ci.yml) to compute the cache key for built native
addons (natives-linux-x64).

Normalizes workspace package version fields in Cargo.toml and Cargo.lock so
version-only bumps (e.g. chore(release)) reuse existing native addon binaries
without forcing an uncached, multi-hour compilation. The native binary version
sentinel is stamped post-link by scripts/stamp-native-version.ts, making binary
recompilation redundant when Rust sources and third-party dependencies are
unchanged.
"""

import hashlib
import os
import re
import sys

FIXED_FILES = [
    "rust-toolchain.toml",
    "rustfmt.toml",
    ".bazelrc",
    ".bazelignore",
    ".bazelversion",
    "BUILD.bazel",
    "MODULE.bazel",
]

WALK_DIRS = ["bazel", "crates"]


def compute_native_inputs_hash(repo_root: str = ".") -> str:
    hasher = hashlib.sha256()

    # 1. Fixed build and toolchain configs
    for relpath in FIXED_FILES:
        filepath = os.path.join(repo_root, relpath)
        if os.path.isfile(filepath):
            hasher.update(relpath.encode("utf-8"))
            with open(filepath, "rb") as f:
                hasher.update(f.read())

    # 2. Cargo.toml (normalized: ignore workspace.package.version)
    cargo_toml_path = os.path.join(repo_root, "Cargo.toml")
    if os.path.isfile(cargo_toml_path):
        hasher.update(b"Cargo.toml")
        with open(cargo_toml_path, "r", encoding="utf-8") as f:
            content = f.read()
        normalized_toml = re.sub(
            r'(?m)^version\s*=\s*"[^"]+"', 'version = "0.0.0"', content
        )
        hasher.update(normalized_toml.encode("utf-8"))

    # 3. Cargo.lock (normalized: ignore workspace member versions)
    cargo_lock_path = os.path.join(repo_root, "Cargo.lock")
    if os.path.isfile(cargo_lock_path):
        hasher.update(b"Cargo.lock")
        with open(cargo_lock_path, "r", encoding="utf-8") as f:
            content = f.read()
        normalized_lock = re.sub(
            r'(name = "pi-[^"]+"\s*\nversion = )"[^"]+"',
            r'\1"0.0.0"',
            content,
        )
        hasher.update(normalized_lock.encode("utf-8"))

    # 4. Directory trees in bazel/ and crates/
    for root_dir in WALK_DIRS:
        base = os.path.join(repo_root, root_dir)
        if not os.path.isdir(base):
            continue
        for root, dirs, files in os.walk(base):
            dirs.sort()
            for fn in sorted(files):
                filepath = os.path.join(root, fn)
                relpath = os.path.relpath(filepath, repo_root).replace("\\", "/")
                hasher.update(relpath.encode("utf-8"))
                with open(filepath, "rb") as f:
                    hasher.update(f.read())

    return hasher.hexdigest()


if __name__ == "__main__":
    repo_root = sys.argv[1] if len(sys.argv) > 1 else "."
    print(compute_native_inputs_hash(repo_root))
