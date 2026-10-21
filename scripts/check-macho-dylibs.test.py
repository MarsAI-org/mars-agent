"""check-macho-dylibs.py reads real Mach-O load commands.

The CI step this replaces shelled out to `llvm-objdump --macho --dylibs-used`,
which is not installed on GitHub-hosted runners. These cases pin the parser
against hand-built Mach-O images so the check keeps working without that tool.

Run with:  python3 -m unittest scripts/check-macho-dylibs.test.py
"""

import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from macho_fixture import fat, macho  # noqa: E402

SCRIPT = Path(__file__).parent / "check-macho-dylibs.py"


def run(binary: bytes, *args: str) -> subprocess.CompletedProcess:
    with tempfile.NamedTemporaryFile(suffix=".node", delete=False) as fh:
        fh.write(binary)
        path = fh.name
    try:
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), path, *args],
            capture_output=True,
            text=True,
        )
    finally:
        Path(path).unlink(missing_ok=True)


class MachoDylibChecks(unittest.TestCase):
    def test_lists_every_linked_dylib(self):
        binary = macho(["/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib"])
        result = run(binary)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.split(),
            ["/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib"],
        )

    def test_ignores_the_images_own_install_name(self):
        # LC_ID_DYLIB is the image's own name, not a dependency.
        binary = macho(["/usr/lib/libSystem.B.dylib"], ident="@rpath/libswiftCore.dylib")
        result = run(binary)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("libswiftCore", result.stdout)

    def test_forbid_fails_and_names_the_match(self):
        binary = macho(["/usr/lib/libSystem.B.dylib", "/usr/lib/swift/libswiftCore.dylib"])
        result = run(binary, "--forbid", "libswift")
        self.assertEqual(result.returncode, 1)
        self.assertIn("libswift", result.stderr)
        self.assertIn("libswiftCore.dylib", result.stderr)

    def test_forbid_passes_when_nothing_matches(self):
        binary = macho(["/usr/lib/libSystem.B.dylib"])
        result = run(binary, "--forbid", "libswift", "--forbid", "FoundationModels")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_universal_binary_reports_every_slice(self):
        binary = fat([macho(["/usr/lib/libSystem.B.dylib"]), macho(["/usr/lib/libswiftCore.dylib"])])
        result = run(binary)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("libSystem", result.stdout)
        self.assertIn("libswiftCore", result.stdout)

    def test_weak_dylib_loads_are_included(self):
        # LC_LOAD_WEAK_DYLIB is still a dependency the loader resolves.
        binary = macho(["/usr/lib/libSystem.B.dylib"])
        weak = struct.pack("<IIIIII", 0x80000018, 24 + 16, 24, 0, 0, 0) + b"/w.dylib\0"
        weak = weak[:4] + struct.pack("<I", len(weak)) + weak[8:]
        patched = bytearray(binary)
        ncmds = struct.unpack_from("<I", patched, 16)[0]
        sizeofcmds = struct.unpack_from("<I", patched, 20)[0]
        struct.pack_into("<I", patched, 16, ncmds + 1)
        struct.pack_into("<I", patched, 20, sizeofcmds + len(weak))
        binary = bytes(patched) + weak

        result = run(binary)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("/w.dylib", result.stdout)

    def test_rejects_a_file_that_is_not_macho(self):
        result = run(b"this is not a binary at all")
        self.assertEqual(result.returncode, 2)
        self.assertTrue("not a Mach-O" in result.stderr or "too small" in result.stderr)


if __name__ == "__main__":
    unittest.main()
