"""Content-addressed cache of pre-built ``packages/natives/native/`` artifacts.

The napi-rs build of ``pi_natives.<platform>-<arch>[-variant].node`` takes
minutes. Most issues never touch ``crates/``, so the same artifact is
buildable in every workspace whose source state matches one we've already
built. This module:

1. Computes a deterministic key from the git tree-hashes of the inputs that
   determine the build output, plus the target triple.
2. On workspace populate: hardlinks cached files into the worktree's
   ``packages/natives/native/`` (a noop on cache miss).
3. On successful task exit: captures the workspace's freshly-built artifacts
   into the cache under its (possibly new) key.

Hardlink semantics give COW for free: every tool in the napi build path
replaces files via write-temp + rename, so a workspace rebuilding the addon
allocates a new inode and leaves the cached file untouched. Cache GC is by
LRU on ``manifest.json.captured_at``; hardlinked workspaces keep the inode
alive after the cache directory is rmtree'd.

Ownership: cache root is provisioned ``root:omp 02770`` by ``entrypoint.sh``
so slot subprocesses (group ``omp``) can capture under setgid inheritance.
Same shape as ``/data/cache/cargo``.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import logging
import os
import platform
import secrets
import shutil
import stat
import subprocess
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from robomp.git_ops import scrub_secret_env

log = logging.getLogger(__name__)


# Paths whose git tree-hash feeds the cache key. Order is significant — the
# hash incorporates the (path, tree_hash) pairs in this exact order so a
# different ordering would produce a different key. Cover every input the
# napi build reads: all workspace crates (pi-natives transitively depends on
# pi-ast/pi-iso/pi-shell), the workspace Cargo manifest + lock, the rust
# toolchain pin, and the natives package itself (build script + scripts/* +
# package.json with napi config).
CACHE_KEY_PATHS: tuple[str, ...] = (
    "crates",
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "packages/natives",
)

# Files in ``packages/natives/native/`` that ARE pure functions of the
# cache-key inputs and travel as a unit. ``.node`` is matched by glob since
# the basename embeds the target triple + variant.
_CACHED_NODE_GLOB = "pi_natives.*.node"
_CACHED_COMPANION_FILES: tuple[str, ...] = (
    "index.d.ts",
    "index.js",
    "embedded-addon.js",
)
_MANIFEST_FILENAME = "manifest.json"
_LOCKFILE_NAME = ".lock"

_NULL_TREE_HASH = "0" * 40  # placeholder for paths missing from HEAD


def _normalize_platform() -> str:
    """Mirror node's ``process.platform`` so the cache key matches
    ``build-native.ts``'s filename convention."""
    s = sys.platform
    if s.startswith("linux"):
        return "linux"
    if s == "darwin":
        return "darwin"
    if s in ("win32", "cygwin"):
        return "win32"
    return s


def _normalize_arch() -> str:
    """Mirror node's ``process.arch``."""
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "x64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return m


def target_triple() -> str:
    """``<platform>-<arch>[-<variant>]`` matching the napi addon basename.

    ``TARGET_VARIANT`` is honored only on x64 (the build script enforces the
    same restriction). On x64 hosts that leave the variant unset we encode
    ``host`` to keep the key stable across workspaces on the same machine
    without trying to autodetect AVX2 from Python.
    """
    plat = _normalize_platform()
    arch = _normalize_arch()
    if arch != "x64":
        return f"{plat}-{arch}"
    variant = os.environ.get("TARGET_VARIANT", "").strip() or "host"
    return f"{plat}-{arch}-{variant}"


_SAFE_GIT_CONFIG_ARGS: tuple[str, ...] = (
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.alternateRefsCommand=",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
)


def _git_safe_directory_env(repo_dir: Path) -> dict[str, str]:
    """Env overlay that whitelists ``repo_dir`` for git's safe.directory check.

    The orchestrator runs as root but workspaces are owned by the slot UID
    (see ``SandboxManager._chown_workspace``). Without this whitelist, every
    git invocation from the orchestrator on a slot-owned repo aborts with
    "fatal: detected dubious ownership". Mirrors
    ``robomp.sandbox._safe_directory_env`` but kept local to avoid a circular
    import (sandbox imports this module).
    """
    env = scrub_secret_env(os.environ.copy())
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    env[f"GIT_CONFIG_KEY_{count}"] = "safe.directory"
    env[f"GIT_CONFIG_VALUE_{count}"] = str(repo_dir)
    env["GIT_CONFIG_COUNT"] = str(count + 1)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = ""
    env["SSH_ASKPASS"] = ""
    return env


def is_workspace_clean_for_capture(repo_dir: Path) -> bool:
    """Return True iff the repo's cache-key input paths have no uncommitted changes.

    Prevents capturing natives built from dirty/uncommitted changes under the
    clean ``HEAD`` tree-hash key, which would otherwise poison clean checkouts.
    Build outputs under ``packages/natives/native`` are excluded so freshly
    built artifacts do not look dirty.
    """
    try:
        proc = subprocess.run(
            [
                "git",
                *_SAFE_GIT_CONFIG_ARGS,
                "status",
                "--porcelain",
                "--",
                *CACHE_KEY_PATHS,
                ":(exclude)packages/natives/native",
            ],
            cwd=str(repo_dir),
            text=True,
            capture_output=True,
            check=False,
            env=_git_safe_directory_env(repo_dir),
            timeout=120.0,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return proc.returncode == 0 and proc.stdout.strip() == ""


def compute_key(repo_dir: Path, *, target: str | None = None) -> str:
    """Deterministic sha256 over the git tree-hashes of cache-key paths.

    Uses ``git cat-file --batch-check`` for one subprocess invocation. Missing
    paths fold in as a fixed null hash so the key remains deterministic
    across repos that don't ship every input file.

    Raises ``subprocess.CalledProcessError`` if ``git`` itself fails (e.g.
    not a repo) — callers SHOULD treat that as "no cache" and proceed.
    """
    tgt = target if target is not None else target_triple()
    stdin = "".join(f"HEAD:{p}\n" for p in CACHE_KEY_PATHS)
    proc = subprocess.run(
        ["git", *_SAFE_GIT_CONFIG_ARGS, "cat-file", "--batch-check"],
        input=stdin,
        cwd=str(repo_dir),
        text=True,
        capture_output=True,
        check=True,
        env=_git_safe_directory_env(repo_dir),
        timeout=120.0,
    )
    lines = proc.stdout.splitlines()
    if len(lines) != len(CACHE_KEY_PATHS):
        raise RuntimeError(
            f"git cat-file returned {len(lines)} lines, expected {len(CACHE_KEY_PATHS)}: {proc.stdout!r}"
        )
    h = hashlib.sha256()
    for path, line in zip(CACHE_KEY_PATHS, lines, strict=True):
        stripped = line.strip()
        if stripped.endswith("missing"):
            tree_hash = _NULL_TREE_HASH
        else:
            # "<hash> <type> <size>" — take the first token as the tree/blob hash.
            tree_hash = stripped.split(None, 1)[0]
        h.update(f"{path}\t{tree_hash}\n".encode())
    h.update(f"TARGET\t{tgt}\n".encode())
    return h.hexdigest()


def _repo_slug(repo: str) -> str:
    """Same convention as ``SandboxManager.pool_path``."""
    return repo.replace("/", "__")


def _is_regular_non_symlink(path: Path) -> bool:
    try:
        st = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode)


def _unique_tmp_path(dst: Path) -> Path:
    return dst.with_suffix(dst.suffix + f".tmp.{os.getpid()}.{secrets.token_hex(6)}")


def _copy_regular_nofollow(
    src: Path,
    dst: Path,
    *,
    mode: int | None = None,
    owner_root: bool = False,
) -> None:
    """Copy a regular non-symlink ``src`` to ``dst`` atomically using ``O_NOFOLLOW``.

    Refuses symlinks and non-regular files on ``src`` so a slot cannot plant a
    symlink (e.g. to ``/etc/shadow`` or ``/data/robomp.sqlite``) for root to read
    into the shared cache.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    src_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    src_fd = os.open(src, src_flags)
    tmp = _unique_tmp_path(dst)
    dst_fd = -1
    try:
        src_st = os.fstat(src_fd)
        if not stat.S_ISREG(src_st.st_mode):
            raise OSError(errno.ELOOP, "refusing non-regular source file", str(src))
        dst_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        dst_fd = os.open(tmp, dst_flags, 0o600)
        while True:
            chunk = os.read(src_fd, 256 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            written = 0
            while written < len(chunk):
                n = os.write(dst_fd, view[written:])
                if n <= 0:
                    raise OSError("short write during cache copy")
                written += n
        if owner_root and os.geteuid() == 0:
            os.fchown(dst_fd, 0, 0)
        if mode is not None:
            os.fchmod(dst_fd, mode)
        else:
            os.fchmod(dst_fd, stat.S_IMODE(src_st.st_mode))
        os.close(dst_fd)
        dst_fd = -1
        os.replace(tmp, dst)
    finally:
        os.close(src_fd)
        if dst_fd != -1:
            os.close(dst_fd)
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _atomic_link(src: Path, dst: Path) -> None:
    """Hardlink ``src`` → ``dst``, replacing any existing ``dst`` atomically.

    Falls back to ``_copy_regular_nofollow`` on ``EXDEV`` (cross-filesystem).
    The replace semantics use a unique sibling temp file + ``os.replace`` so a
    crash mid-link doesn't leave ``dst`` half-overwritten and concurrent threads
    cannot collide.
    """
    if not _is_regular_non_symlink(src):
        raise OSError(errno.ELOOP, "refusing to link non-regular or symlinked cache file", str(src))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = _unique_tmp_path(dst)
    try:
        try:
            os.link(src, tmp)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            _copy_regular_nofollow(src, tmp)
        os.replace(tmp, dst)
    finally:
        # Best-effort cleanup if os.link succeeded but os.replace blew up.
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _atomic_copy(
    src: Path,
    dst: Path,
    *,
    mode: int | None = None,
    owner_root: bool = False,
) -> None:
    """Copy ``src`` → ``dst`` via a unique sibling temp file + ``os.replace``.

    Used for cached files that downstream tools rewrite via
    ``open(..., 'w')`` (in-place truncate). Replacing the workspace dst
    atomically means a fresh inode every populate — the cache file is
    never mutated through a hardlink.
    """
    _copy_regular_nofollow(src, dst, mode=mode, owner_root=owner_root)


@contextmanager
def _flock(path: Path) -> Generator[IO[bytes]]:
    """Exclusive ``fcntl.flock`` on ``path`` (created if missing).

    ``flock`` is advisory but every caller goes through ``NativesCache``, so
    cooperative locking is sufficient. POSIX-only — Windows is not a target.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "ab+")  # noqa: SIM115 — managed by the context manager
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield fh
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


@dataclass(slots=True, frozen=True)
class CacheHit:
    """Files copied/linked into the workspace by ``populate_workspace``."""

    cache_dir: Path
    files: tuple[Path, ...]


class NativesCache:
    """Per-repo content-addressed cache of pi-natives build outputs."""

    def __init__(
        self,
        root: Path,
        *,
        max_entries_per_repo: int = 8,
        max_bytes: int = 4 * 1024**3,
    ) -> None:
        self.root = root
        self.max_entries_per_repo = max(1, max_entries_per_repo)
        self.max_bytes = max(0, max_bytes)
        root.mkdir(parents=True, exist_ok=True)

    # ---- layout helpers ----
    def repo_root(self, repo: str) -> Path:
        return self.root / _repo_slug(repo)

    def entry_dir(self, repo: str, key: str) -> Path:
        return self.repo_root(repo) / key

    def lockfile(self, repo: str) -> Path:
        return self.repo_root(repo) / _LOCKFILE_NAME

    # ---- query ----
    def lookup(self, repo: str, key: str) -> Path | None:
        """Return the cache directory if ``key`` is present and complete."""
        entry = self.entry_dir(repo, key)
        if not (entry / _MANIFEST_FILENAME).exists():
            return None
        # A complete entry has a node file plus all companions.
        if not list(entry.glob(_CACHED_NODE_GLOB)):
            return None
        for name in _CACHED_COMPANION_FILES:
            if not (entry / name).exists():
                return None
        return entry

    # ---- populate (workspace ← cache) ----
    def populate_workspace(
        self,
        repo: str,
        key: str,
        native_dir: Path,
    ) -> CacheHit | None:
        """Hardlink the `.node`, copy companions, into ``native_dir``.

        Returns the ``CacheHit`` on a hit; ``None`` on miss. Caller has
        already computed ``key`` and verified ``native_dir`` exists.

        Why hardlink the .node but COPY the companions: the napi build's
        ``installBinary`` replaces the .node via temp + rename (new inode,
        cache safe), but ``installGeneratedBindings`` and ``gen-enums.ts``
        rewrite ``index.d.ts`` / ``index.js`` / ``embedded-addon.js`` with
        plain ``open(..., 'w')`` — that's open-truncate-write IN PLACE on
        Linux. A hardlinked companion would propagate the truncate into the
        cache. Copies are independent inodes and absorb the rewrite safely.
        """
        entry = self.lookup(repo, key)
        if entry is None:
            return None
        native_dir.mkdir(parents=True, exist_ok=True)
        copied: list[Path] = []
        for src in entry.glob(_CACHED_NODE_GLOB):
            dst = native_dir / src.name
            _atomic_link(src, dst)
            copied.append(dst)
        for name in _CACHED_COMPANION_FILES:
            src = entry / name
            dst = native_dir / name
            _atomic_copy(src, dst)
            copied.append(dst)
        return CacheHit(cache_dir=entry, files=tuple(copied))

    # ---- capture (cache ← workspace) ----
    def capture(
        self,
        repo: str,
        key: str,
        native_dir: Path,
        *,
        source_workspace: str | None = None,
        commit: str | None = None,
    ) -> Path | None:
        """Atomically capture ``native_dir`` contents under ``key``.

        Returns the final cache directory on store, ``None`` if there was
        nothing to capture or if another worker already populated the same
        key (idempotent under flock).
        """
        try:
            native_st = native_dir.lstat()
        except OSError:
            return None
        if not stat.S_ISDIR(native_st.st_mode):
            return None

        node_files = sorted(native_dir.glob(_CACHED_NODE_GLOB))
        if not node_files:
            return None
        if any(not _is_regular_non_symlink(src) for src in node_files):
            log.warning("natives_cache capture refused symlink/non-regular .node file", extra={"dir": str(native_dir)})
            return None
        # Every companion must exist and be a regular non-symlink file.
        for name in _CACHED_COMPANION_FILES:
            if not _is_regular_non_symlink(native_dir / name):
                return None

        # Refuse capture from dirty git worktrees so uncommitted edits to
        # cache-key inputs cannot poison the clean HEAD cache entry.
        if (
            len(native_dir.parents) >= 3
            and native_dir.name == "native"
            and native_dir.parent.name == "natives"
            and native_dir.parent.parent.name == "packages"
        ):
            repo_dir = native_dir.parents[2]
            if (repo_dir / ".git").exists() and not is_workspace_clean_for_capture(repo_dir):
                log.warning(
                    "natives_cache capture refused dirty cache-key inputs",
                    extra={"repo": repo, "key": key, "dir": str(native_dir)},
                )
                return None

        repo_root = self.repo_root(repo)
        repo_root.mkdir(parents=True, exist_ok=True)
        with _flock(self.lockfile(repo)):
            # TOCTOU recheck: another worker may have captured the same key
            # while we waited on the lock.
            if self.lookup(repo, key) is not None:
                return self.entry_dir(repo, key)

            final = self.entry_dir(repo, key)
            staging = repo_root / f".{key}.tmp.{os.getpid()}.{secrets.token_hex(6)}"
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True)
            try:
                # NOTE: capture uses COPY with O_NOFOLLOW, not hardlink. Cached
                # `.node` files are stored read-only (0o444) and owned by
                # `root:root` so hardlinking them into slot workspaces allows
                # every slot to read them while preventing any slot from
                # mutating the shared inode in place.
                for src in node_files:
                    _atomic_copy(src, staging / src.name, mode=0o444, owner_root=True)
                for name in _CACHED_COMPANION_FILES:
                    _atomic_copy(native_dir / name, staging / name, mode=0o644)
                manifest = {
                    "key": key,
                    "target": target_triple(),
                    "captured_at": time.time(),
                    "source_workspace": source_workspace,
                    "commit": commit,
                    "node_files": [src.name for src in node_files],
                }
                (staging / _MANIFEST_FILENAME).write_text(
                    json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
                )
                os.replace(staging, final)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
            self._gc_locked(repo)
            return final

    # ---- gc ----
    def gc(self, repo: str | None = None) -> int:
        """Evict entries beyond per-repo or total caps.

        ``repo`` scopes to one repo when given; otherwise sweeps every repo
        directory under ``root``. Returns the count of evicted entries.
        """
        if repo is not None:
            with _flock(self.lockfile(repo)):
                return self._gc_locked(repo)
        total = 0
        if not self.root.exists():
            return 0
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            # Reconstruct repo identifier from directory name (best-effort;
            # only used for lockfile path, not for any externally-visible
            # identifier).
            repo_name = child.name.replace("__", "/", 1)
            try:
                with _flock(self.lockfile(repo_name)):
                    total += self._gc_locked(repo_name)
            except OSError as exc:
                log.warning("natives_cache gc skip", extra={"repo": child.name, "err": str(exc)})
        return total

    def _gc_locked(self, repo: str) -> int:
        """Caller MUST hold the per-repo flock."""
        repo_root = self.repo_root(repo)
        if not repo_root.exists():
            return 0
        entries: list[tuple[float, int, Path]] = []
        for child in repo_root.iterdir():
            if not child.is_dir():
                # Stale staging dirs (".<key>.tmp.<pid>") from a crashed
                # capture: drop them opportunistically.
                continue
            if child.name.startswith("."):
                shutil.rmtree(child, ignore_errors=True)
                continue
            manifest_path = child / _MANIFEST_FILENAME
            if not manifest_path.exists():
                # Incomplete entry — evict.
                shutil.rmtree(child, ignore_errors=True)
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                captured_at = float(manifest.get("captured_at", 0.0))
            except (OSError, ValueError, json.JSONDecodeError):
                captured_at = manifest_path.stat().st_mtime
            size = _dir_size(child)
            entries.append((captured_at, size, child))
        entries.sort(key=lambda row: row[0])  # oldest first

        evicted = 0
        # 1. Per-repo entry-count cap (drop oldest).
        while len(entries) > self.max_entries_per_repo:
            _, _, victim = entries.pop(0)
            shutil.rmtree(victim, ignore_errors=True)
            evicted += 1

        # 2. Per-repo byte cap (drop oldest until under).
        if self.max_bytes > 0:
            total = sum(size for _, size, _ in entries)
            while total > self.max_bytes and len(entries) > 1:
                _, size, victim = entries.pop(0)
                shutil.rmtree(victim, ignore_errors=True)
                total -= size
                evicted += 1
        return evicted


def _dir_size(path: Path) -> int:
    """Sum of file sizes under ``path``. Symlinks counted as their lstat
    size (not the target). Errors swallowed — GC is best-effort."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


__all__ = [
    "CACHE_KEY_PATHS",
    "CacheHit",
    "NativesCache",
    "compute_key",
    "is_workspace_clean_for_capture",
    "target_triple",
]
