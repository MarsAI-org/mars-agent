#!/bin/sh
# Mars Termux Tier-1 glibc-Compatibility Launcher
#
# Runs the official prebuilt linux-arm64 Mars binary inside native Termux on
# Android without containerization or PRoot, using Termux's glibc runner.
#
# Usage:
#   sh mars-termux-launcher.sh [mars-flags...]
# Or symlink to $PREFIX/bin/mars:
#   ln -s /path/to/mars-termux-launcher.sh $PREFIX/bin/mars

set -e

# Resolve target Mars binary
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARS_BIN="${MARS_BIN:-}"

if [ -z "$MARS_BIN" ]; then
	if [ -f "$SCRIPT_DIR/../../packages/coding-agent/binaries/mars-linux-arm64" ]; then
		MARS_BIN="$SCRIPT_DIR/../../packages/coding-agent/binaries/mars-linux-arm64"
	elif [ -f "$HOME/.local/bin/mars-linux-arm64" ]; then
		MARS_BIN="$HOME/.local/bin/mars-linux-arm64"
	elif [ -f "$HOME/.mars/bin/mars-linux-arm64" ]; then
		MARS_BIN="$HOME/.mars/bin/mars-linux-arm64"
	elif [ -f "$SCRIPT_DIR/mars-linux-arm64" ]; then
		MARS_BIN="$SCRIPT_DIR/mars-linux-arm64"
	fi
fi

# Locate glibc runner or direct loader in Termux
GLIBC_RUNNER=""
if command -v grun >/dev/null 2>&1; then
	GLIBC_RUNNER="grun"
elif [ -n "$PREFIX" ] && [ -x "$PREFIX/glibc/bin/grun" ]; then
	GLIBC_RUNNER="$PREFIX/glibc/bin/grun"
elif [ -n "$PREFIX" ] && [ -x "$PREFIX/glibc/lib/ld-linux-aarch64.so.1" ]; then
	GLIBC_LOADER="$PREFIX/glibc/lib/ld-linux-aarch64.so.1"
fi

# Fail-fast with clear remediation commands if prerequisites are missing
if [ -z "$GLIBC_RUNNER" ] && [ -z "${GLIBC_LOADER:-}" ]; then
	cat >&2 <<'EOF'
mars: Termux native execution requires the glibc compatibility packages.
To install them, run the following commands in Termux:

  pkg update
  pkg install glibc-repo
  pkg install glibc-runner

Once installed, re-run this command.
EOF
	exit 127
fi

if [ -z "$MARS_BIN" ] || [ ! -f "$MARS_BIN" ]; then
	cat >&2 <<EOF
mars: Mars binary for linux-arm64 not found.
Set MARS_BIN=/path/to/mars-linux-arm64 or install it to ~/.local/bin/mars-linux-arm64
EOF
	exit 1
fi

# CRITICAL HYGIENE: Termux injects libtermux-exec.so via LD_PRELOAD to rewrite /bin/sh.
# That Bionic-linked shared object crashes glibc's dynamic loader immediately with
# a symbol mismatch. Unset or sanitize LD_PRELOAD before entering glibc userland.
unset LD_PRELOAD

# Set default memory/process parameters friendly to Android
export MARS_PLATFORM="android-termux"

# Execute the binary through the glibc runner or loader, preserving all args and exit code
if [ -n "$GLIBC_RUNNER" ]; then
	exec "$GLIBC_RUNNER" "$MARS_BIN" "$@"
else
	exec "$GLIBC_LOADER" --library-path "$PREFIX/glibc/lib" "$MARS_BIN" "$@"
fi
