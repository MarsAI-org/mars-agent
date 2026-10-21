#!/usr/bin/env python3
"""Report the dylibs a Mach-O binary links, without any external tool.

`llvm-objdump --macho --dylibs-used` is the usual way to answer this, but it is
not installed on GitHub-hosted runners and the hermetic LLVM download does not
prune it in. Reaching for `apt-get` would add a network dependency and a version
that drifts from the one that produced the binary, so this reads the load
commands directly: they are a fixed, documented layout and the only thing the
caller needs is the set of LC_LOAD_DYLIB names.

Usage:
    check-macho-dylibs.py <binary> [--forbid PATTERN ...]

Prints one dylib path per line. With `--forbid`, exits 1 and names the match if
any linked dylib matches one of the patterns.
"""

import struct
import sys

# Load commands that name a dylib this image depends on. LC_ID_DYLIB is the
# image's own install name, so it is not a dependency and is skipped.
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_REEXPORT_DYLIB = 0x8000001F
LC_LOAD_UPWARD_DYLIB = 0x80000023
DYLIBCMDS = {LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB}

MH_MAGIC_64 = 0xFEEDFACF
MH_MAGIC = 0xFEEDFACE
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF


def _read_dylibs(data: bytes, offset: int) -> list[str]:
    """Dylib names from the Mach-O image whose header starts at `offset`."""
    if len(data) < offset + 4:
        return []
    magic_le = struct.unpack_from("<I", data, offset)[0]
    magic_be = struct.unpack_from(">I", data, offset)[0]

    if magic_le == MH_MAGIC_64 or magic_be == MH_MAGIC_64:
        endian, header_size = ("<", 32) if magic_le == MH_MAGIC_64 else (">", 32)
    elif magic_le == MH_MAGIC or magic_be == MH_MAGIC:
        endian, header_size = ("<", 28) if magic_le == MH_MAGIC else (">", 28)
    else:
        raise ValueError(f"not a Mach-O image at offset {offset} (magic {magic_le:#x})")

    # struct mach_header{,_64}: magic, cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags[, reserved]
    ncmds = struct.unpack_from(endian + "I", data, offset + 16)[0]
    cursor = offset + header_size
    names: list[str] = []
    for _ in range(ncmds):
        if len(data) < cursor + 8:
            break
        cmd, cmdsize = struct.unpack_from(endian + "II", data, cursor)
        if cmdsize < 8:
            break
        if cmd in DYLIBCMDS:
            # struct dylib_command: cmd, cmdsize, dylib{name(lc_str), timestamp, current, compat}
            name_offset = struct.unpack_from(endian + "I", data, cursor + 8)[0]
            start = cursor + name_offset
            end = data.find(b"\0", start, cursor + cmdsize)
            if end == -1:
                end = cursor + cmdsize
            names.append(data[start:end].decode("utf-8", "replace"))
        cursor += cmdsize
    return names


def dylibs(data: bytes) -> list[str]:
    """Every dylib linked by the image, unwrapping a universal binary."""
    if len(data) < 8:
        raise ValueError("file is too small to be a Mach-O image")

    magic = struct.unpack_from(">I", data, 0)[0]
    if magic in (FAT_MAGIC, FAT_MAGIC_64):
        # fat_header: magic, nfat_arch; then fat_arch{,_64} entries.
        nfat = struct.unpack_from(">I", data, 4)[0]
        entry_size = 32 if magic == FAT_MAGIC_64 else 20
        names: list[str] = []
        for i in range(nfat):
            base = 8 + i * entry_size
            if magic == FAT_MAGIC_64:
                offset = struct.unpack_from(">Q", data, base + 8)[0]
            else:
                offset = struct.unpack_from(">I", data, base + 8)[0]
            names.extend(_read_dylibs(data, offset))
        return names

    return _read_dylibs(data, 0)


def main(argv: list[str]) -> int:
    args = argv[1:]
    if not args:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: check-macho-dylibs.py <binary> [--forbid PATTERN ...]", file=sys.stderr)
        return 2

    path = args[0]
    forbid: list[str] = []
    rest = args[1:]
    i = 0
    while i < len(rest):
        if rest[i] == "--forbid" and i + 1 < len(rest):
            forbid.append(rest[i + 1])
            i += 2
        else:
            print(f"unexpected argument: {rest[i]}", file=sys.stderr)
            return 2

    try:
        with open(path, "rb") as fh:
            data = fh.read()
        names = dylibs(data)
    except (OSError, ValueError, struct.error) as err:
        print(f"{path}: {err}", file=sys.stderr)
        return 2

    for name in names:
        print(name)

    for pattern in forbid:
        hits = [name for name in names if pattern in name]
        if hits:
            print(f"error: {path} links {pattern!r}: {', '.join(hits)}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
