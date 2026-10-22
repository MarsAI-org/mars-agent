import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from native_inputs_hash import compute_native_inputs_hash

class TestNativeInputsHash(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "bazel"))
        os.makedirs(os.path.join(self.tmp, "crates", "pi-test"))
        with open(os.path.join(self.tmp, "rust-toolchain.toml"), "w") as f:
            f.write('[toolchain]\nchannel = "nightly"\n')
        with open(os.path.join(self.tmp, "Cargo.toml"), "w") as f:
            f.write('[workspace.package]\nversion = "0.1.0"\n')
        with open(os.path.join(self.tmp, "Cargo.lock"), "w") as f:
            f.write('[[package]]\nname = "pi-test"\nversion = "0.1.0"\n')
        with open(os.path.join(self.tmp, "crates", "pi-test", "lib.rs"), "w") as f:
            f.write('pub fn test() {}\n')

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_version_bump_keeps_hash_identical(self):
        h1 = compute_native_inputs_hash(self.tmp)

        # Bump workspace package version
        with open(os.path.join(self.tmp, "Cargo.toml"), "w") as f:
            f.write('[workspace.package]\nversion = "0.2.0"\n')
        with open(os.path.join(self.tmp, "Cargo.lock"), "w") as f:
            f.write('[[package]]\nname = "pi-test"\nversion = "0.2.0"\n')

        h2 = compute_native_inputs_hash(self.tmp)
        self.assertEqual(h1, h2)

    def test_rust_source_change_changes_hash(self):
        h1 = compute_native_inputs_hash(self.tmp)
        with open(os.path.join(self.tmp, "crates", "pi-test", "lib.rs"), "w") as f:
            f.write('pub fn test_modified() {}\n')
        h2 = compute_native_inputs_hash(self.tmp)
        self.assertNotEqual(h1, h2)

    def test_dependency_change_changes_hash(self):
        h1 = compute_native_inputs_hash(self.tmp)
        with open(os.path.join(self.tmp, "Cargo.lock"), "a") as f:
            f.write('\n[[package]]\nname = "serde"\nversion = "1.0.0"\n')
        h2 = compute_native_inputs_hash(self.tmp)
        self.assertNotEqual(h1, h2)

if __name__ == "__main__":
    unittest.main()
