"""Build a minimal but real Mach-O image to test check-macho-dylibs.py.

Writing the bytes here (rather than checking in a binary fixture) keeps the
test readable and lets it cover the fat and thin cases from one source.
"""

import struct

MH_MAGIC_64 = 0xFEEDFACF
CPU_TYPE_ARM64 = 0x0100000C
CPU_TYPE_X86_64 = 0x01000007
MH_DYLIB = 0x6
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_ID_DYLIB = 0xD
FAT_MAGIC = 0xCAFEBABE


def _dylib_cmd(cmd: int, name: str) -> bytes:
    """One dylib_command, padded to 8-byte alignment."""
    raw = name.encode() + b"\0"
    # cmd, cmdsize, name_offset(24), timestamp, current_version, compat_version
    header = struct.pack("<IIIIII", cmd, 24 + len(raw), 24, 0, 0, 0)
    body = header + raw
    pad = (-len(body)) % 8
    body += b"\0" * pad
    # cmdsize must include the padding.
    return body[:4] + struct.pack("<I", len(body)) + body[8:]


def macho(dylibs: list[str], *, cputype: int = CPU_TYPE_ARM64, ident: str = "@rpath/libtest.dylib") -> bytes:
    cmds = [_dylib_cmd(LC_ID_DYLIB, ident)]
    cmds += [_dylib_cmd(LC_LOAD_DYLIB, name) for name in dylibs]
    sizeofcmds = sum(len(c) for c in cmds)

    # mach_header_64: magic, cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags, reserved
    header = struct.pack(
        "<IIIIIIII",
        MH_MAGIC_64,
        cputype,
        0,
        MH_DYLIB,
        len(cmds),
        sizeofcmds,
        0,
        0,
    )
    return header + b"".join(cmds)


def fat(slices: list[bytes]) -> bytes:
    """A universal binary wrapping `slices`, each 8-byte aligned."""
    nfat = len(slices)
    entry_size = 20
    data_start = 8 + nfat * entry_size

    offsets = []
    cursor = data_start
    for sl in slices:
        offsets.append(cursor)
        cursor += len(sl)
        cursor += (-cursor) % 8

    out = struct.pack(">II", FAT_MAGIC, nfat)
    for sl, off in zip(slices, offsets):
        # fat_arch: cputype, cpusubtype, offset, size, align
        out += struct.pack(">IIIII", CPU_TYPE_ARM64, 0, off, len(sl), 3)
    out += b"\0" * (data_start - len(out))

    for sl, off in zip(slices, offsets):
        out += b"\0" * (off - len(out))
        out += sl
    return out
