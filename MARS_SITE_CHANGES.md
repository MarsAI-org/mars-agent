# Mars Site Install-Script Changes for Native Android/Termux (Reference Only)

**This file documents the required changes for the `mars-site` repository's install
script (`install`). The `mars-site` repo is a separate repository and was NOT
modified by this work; this document is the exact specification for that change.**
Everything about on-device behavior below is **UNVERIFIED** until a human runs the
checklist in `TERMUX_TEST_CHECKLIST.md` on a real phone.

## 1. Detect Termux

Insert near the top of `install`, after the `host_arch()` helper:

```sh
# True when running inside Termux on Android (native Termux, no proot).
is_termux() {
    [ -n "$PREFIX" ] && [ -d "$PREFIX" ]
}
```

`$PREFIX` (e.g. `/data/data/com.termux/files/usr`) is set by Termux and absent on
desktop Linux. This matches the runtime detection in
`packages/utils/src/platform.ts` (`isTermux`), so the installer and the binary agree.

## 2. Choose the installation path

In `install_binary()`, after the existing `PLATFORM`/`ARCH` resolution:

```sh
if is_termux; then
    # Tier 1: native Termux (no proot). The official linux-arm64 glibc binary
    # runs through the Termux glibc loader. Verify the loader exists first.
    if ! command -v grun >/dev/null 2>&1 && [ ! -x "$PREFIX/glibc/lib/ld-linux-aarch64.so.1" ]; then
        cat >&2 <<'EOF'
mars: native Termux execution needs the glibc compatibility packages.
Run these commands in Termux, then re-run this installer:

  pkg update
  pkg install glibc-repo
  pkg install glibc-runner
EOF
        exit 1
    fi
    BINARY_NAME="mars-linux-arm64"
    INSTALL_DIR="$PREFIX/bin"
    LAUNCHER="true"
fi
```

The installer must **never** run `pkg install` silently. It prints the exact
commands and exits so the user stays in control of their device.

## 3. Verify the artifact checksum before use

After downloading `mars-linux-arm64`:

```sh
curl -fsSL "$BASE_URL/mars-linux-arm64" -o "$INSTALL_DIR/mars-linux-arm64"
curl -fsSL "$BASE_URL/SHA256SUMS.txt" -o "$TMP_DIR/SHA256SUMS.txt"
cd "$INSTALL_DIR"
sha256sum --ignore-missing --check "$TMP_DIR/SHA256SUMS.txt" || {
    echo "mars: checksum verification failed; aborting" >&2
    exit 1
}
chmod +x "$INSTALL_DIR/mars-linux-arm64"
```

## 4. Install under the Termux home, never shared storage

- Binary: `$PREFIX/bin/mars-linux-arm64` (Termux home), or `$HOME/.local/bin`.
- Never install to `/sdcard` or `/storage/emulated`: Android scoped storage makes
  it non-executable and updates fail (platform behavior UNVERIFIED per device).
- Config and data live under `$HOME/.mars` by default; the installer must not
  relocate them to shared storage.

## 5. Print the launcher location

`scripts/android/mars-termux-launcher.sh` ships with the repo. On Termux, install
it as `$PREFIX/bin/mars` so the `mars` command starts the binary through the
glibc loader with `LD_PRELOAD` cleared:

```sh
cp "$TMP_DIR/mars-termux-launcher.sh" "$PREFIX/bin/mars"
chmod +x "$PREFIX/bin/mars"
echo "Installed. 'mars' now starts through the Termux glibc runner."
```

If the user prefers not to install the launcher, the installer ends with:

```
mars: installed to $PREFIX/bin/mars-linux-arm64
mars: run it with: sh scripts/android/mars-termux-launcher.sh
```

## 6. update-cli hint text on Termux

The self-updater (see `packages/coding-agent/src/cli/update-cli.ts`) prints update
hints. On Termux, that hint must also mention the glibc prerequisite so an update
never leaves the user with a binary that will not start:

```
mars updated. On Termux, ensure the glibc packages stay installed:
  pkg install glibc-repo glibc-runner
```

## 7. Out of scope for this document

- PRoot-distro paths are intentionally not installed by this script (unsupported).
- Android arm64 *release artifacts* built for Bionic are a release-workflow
  decision; the site script only consumes artifacts that already exist.
