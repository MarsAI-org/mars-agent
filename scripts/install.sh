#!/bin/sh
set -e

# Mars Coding Agent Installer
# Usage: curl -fsSL https://getmars.eu.cc/install | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="MarsAI-org/mars-agent"
PACKAGE="@marsai-org/coding-agent"
INSTALL_DIR="${MARS_INSTALL_DIR:-${PI_INSTALL_DIR:-$HOME/.local/bin}}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate --ref / -r values so malformed refs cannot manipulate GitHub API URL paths.
validate_ref() {
    case "$1" in
        ''|-*|*..*|*[[:space:]]*|*[\?\*\#\;\`\$\\]*)
            echo "Invalid ref: $1"
            exit 1
            ;;
    esac
}

# If a ref is provided, validate it and default to source install
if [ -n "$REF" ]; then
    validate_ref "$REF"
    if [ -z "$MODE" ]; then
        MODE="source"
    fi
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Render a byte count as a short human-readable size (e.g. 37562240 -> "36 MiB").
# Pure shell so it works on any POSIX system without coreutils' numfmt.
numfmt_bytes() {
    BYTES="$1"
    if [ "$BYTES" -lt 1024 ]; then
        echo "${BYTES} B"
    elif [ "$BYTES" -lt 1048576 ]; then
        echo "$((BYTES / 1024)) KiB"
    elif [ "$BYTES" -lt 1073741824 ]; then
        echo "$((BYTES / 1048576)) MiB"
    else
        echo "$((BYTES / 1073741824)) GiB"
    fi
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    # Missing components count as 0, so "1.4" is 1.4.0. The old derivation read the
    # patch out of the minor when the version had only two components, which made
    # "1.4" compare as 1.4.4 (version_ge 1.4.0 1.4 was false). Disable globbing
    # around unquoted splitting so malformed version strings cannot expand filenames.
    saved_ifs="$IFS"
    case "$-" in
        *f*) had_noglob=1 ;;
        *)   had_noglob=0; set -f ;;
    esac
    IFS=.
    set -- $current
    current_major="${1:-0}"
    current_minor="${2:-0}"
    current_patch="${3:-0}"
    set -- $minimum
    minimum_major="${1:-0}"
    minimum_minor="${2:-0}"
    minimum_patch="${3:-0}"
    IFS="$saved_ifs"
    if [ "$had_noglob" -eq 0 ]; then
        set +f
    fi

    # A version string that is not three integers (a -canary tag that survived
    # the trim, a vendor suffix) compares as older than the minimum instead of
    # making `test` fail and aborting the installer with a shell error.
    case "${current_major}${current_minor}${current_patch}${minimum_major}${minimum_minor}${minimum_patch}" in
        ''|*[!0-9]*) return 1 ;;
    esac

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Host is Android (Termux, Android shell). `uname -s` says Linux there, but the
# released binaries link the glibc loader Android does not ship, so the download
# only fails later with a relocation error.
is_android() {
    if [ -n "${TERMUX_VERSION:-}" ] || [ -n "${ANDROID_ROOT:-}" ]; then
        return 0
    fi
    [ "$(uname -o 2>/dev/null || echo)" = "Android" ]
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed mars via bun"
    echo "Run 'mars' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    if is_android; then
        echo "Android/Termux has no prebuilt binary: the Linux builds link the glibc loader, which Android does not ship."
        echo "Re-run without --binary to install from source instead."
        exit 1
    fi

    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="mars-${PLATFORM}-${ARCH}"
    # Get release tag
    AUTH_HEADER=""
    if [ -n "$GITHUB_TOKEN" ]; then
        AUTH_HEADER="Authorization: token $GITHUB_TOKEN"
    fi
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if [ -n "$AUTH_HEADER" ]; then
            RELEASE_JSON=$(curl -fsSL -H "User-Agent: Mars-Installer" -H "$AUTH_HEADER" --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}" || true)
        else
            RELEASE_JSON=$(curl -fsSL -H "User-Agent: Mars-Installer" --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}" || true)
        fi
        if [ -n "$RELEASE_JSON" ]; then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -n 1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        if [ -n "$AUTH_HEADER" ]; then
            RELEASE_JSON=$(curl -fsSL -H "User-Agent: Mars-Installer" -H "$AUTH_HEADER" --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest" || true)
        else
            RELEASE_JSON=$(curl -fsSL -H "User-Agent: Mars-Installer" --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest" || true)
        fi
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -n 1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        if [ -n "$REF" ]; then
            echo "Release tag not found: $REF"
        else
            echo "Failed to fetch the latest release tag (network error or GitHub API rate limit)."
        fi
        echo "For branch/commit installs, use --source with --ref."
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary and SHA256SUMS.txt for checksum verification
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    CHECKSUM_URL="https://github.com/${REPO}/releases/download/${LATEST}/SHA256SUMS.txt"
    # Stage the download beside the destination using mktemp and only rename it
    # into place once it verifies and starts. curl truncates its output file as
    # soon as the body arrives, so writing straight to ${INSTALL_DIR}/mars
    # destroyed a working install whenever a transfer was cut short or a checksum
    # differed. The final rename also replaces a running binary cleanly.
    STAGED="$(mktemp "${INSTALL_DIR}/.mars-download.XXXXXX")"
    trap 'rm -f "$STAGED"' EXIT HUP INT TERM
    if [ -t 2 ]; then
        # Interactive terminal: show a progress meter.
        echo "Downloading ${BINARY}..."
        if ! curl -fL --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar "$BINARY_URL" -o "$STAGED"; then
            echo "Download failed for ${BINARY}; ${INSTALL_DIR}/mars was left untouched."
            exit 1
        fi
        # Progress meter writes to stderr; close it out with a summary line.
        DOWNLOADED_SIZE=$(wc -c < "$STAGED" 2>/dev/null | tr -d ' ')
        case "$DOWNLOADED_SIZE" in
            ''|*[!0-9]*) ;;
            *) echo "Downloaded ${BINARY} ($(numfmt_bytes "$DOWNLOADED_SIZE"))" ;;
        esac
    else
        # Piped (curl | sh): keep stderr quiet, but still report stall-safe progress.
        echo "Downloading ${BINARY}..."
        if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$STAGED"; then
            echo "Download failed for ${BINARY}; ${INSTALL_DIR}/mars was left untouched."
            exit 1
        fi
    fi

    echo "Verifying checksum..."
    CHECKSUMS_DATA=$(curl -fsSL --connect-timeout 10 --max-time 30 "$CHECKSUM_URL" || true)
    EXPECTED_SHA=""
    if [ -n "$CHECKSUMS_DATA" ]; then
        # Strip CR (CRLF files) and match both text ("  name") and binary (" *name")
        # or path-prefixed (" ./name", " dir/name") sha256sum output formats.
        EXPECTED_SHA=$(printf '%s\n' "$CHECKSUMS_DATA" | tr -d '\r' | awk -v bin="$BINARY" '
            NF >= 2 {
                name = $2
                sub(/^\*/, "", name)
                sub(/^.*\//, "", name)
                if (name == bin) {
                    print tolower($1)
                    exit
                }
            }
        ')
    fi

    ACTUAL_SHA=""
    if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL_SHA=$(sha256sum "$STAGED" | awk '{print tolower($1)}')
    elif command -v shasum >/dev/null 2>&1; then
        ACTUAL_SHA=$(shasum -a 256 "$STAGED" | awk '{print tolower($1)}')
    fi

    # Fail closed. SHA256SUMS.txt ships in the same release as the binary, so it
    # proves the download was not corrupted or swapped in transit — skipping it
    # silently removes even that. MARS_ALLOW_UNVERIFIED=1 is the explicit opt-out
    # for hosts with no sha256 tool.
    VERIFY_PROBLEM=""
    if [ -z "$CHECKSUMS_DATA" ]; then
        VERIFY_PROBLEM="could not fetch SHA256SUMS.txt"
    elif [ -z "$EXPECTED_SHA" ]; then
        VERIFY_PROBLEM="binary ${BINARY} is not listed in SHA256SUMS.txt"
    elif [ -z "$ACTUAL_SHA" ]; then
        VERIFY_PROBLEM="neither sha256sum nor shasum is available to verify the download"
    elif [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
        echo "Checksum verification failed for ${BINARY}!"
        echo "Expected: $EXPECTED_SHA"
        echo "Actual:   $ACTUAL_SHA"
        echo "The staged download was discarded; ${INSTALL_DIR}/mars was left untouched."
        exit 1
    fi

    if [ -n "$VERIFY_PROBLEM" ]; then
        if [ "${MARS_ALLOW_UNVERIFIED:-0}" = "1" ]; then
            echo "Warning: ${VERIFY_PROBLEM}; continuing because MARS_ALLOW_UNVERIFIED=1."
        else
            echo "Error: ${VERIFY_PROBLEM}."
            echo "Refusing to install an unverified binary. Set MARS_ALLOW_UNVERIFIED=1 to override."
            echo "The staged download was discarded; ${INSTALL_DIR}/mars was left untouched."
            exit 1
        fi
    else
        echo "✓ Checksum verified ($EXPECTED_SHA)"
    fi

    chmod +x "$STAGED"

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("$STAGED" --version 2>&1)"; then
        echo ""
        echo "✗ mars was downloaded and verified, but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run this installer:"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        echo "The staged download was discarded; ${INSTALL_DIR}/mars was left untouched."
        exit 1
    fi

    # Everything passed: swap the staged download in. A rename is atomic within
    # the directory, so a reader (or a running 'mars') sees either the old binary
    # or the new one, never a half-written file.
    mv -f "$STAGED" "${INSTALL_DIR}/mars"

    echo ""
    echo "✓ Installed mars to ${INSTALL_DIR}/mars"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'mars' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'mars'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: prefer prebuilt binary for supported platforms
        OS="$(uname -s)"
        ARCH="$(host_arch)"

        if is_android; then
            echo "Android/Termux detected: no prebuilt binary matches (the Linux builds link the glibc loader)."
            echo "Installing from source instead..."
            if ! has_bun; then
                install_bun
            fi
            require_bun_version
            install_via_bun
            exit 0
        fi

        case "$OS-$ARCH" in
            Linux-x64|Linux-arm64|Darwin-x64|Darwin-arm64)
                install_binary
                ;;
            *)
                echo "No prebuilt binary for $OS-$ARCH; falling back to source install..."
                if ! has_bun; then
                    install_bun
                fi
                require_bun_version
                install_via_bun
                ;;
        esac
        ;;
esac
