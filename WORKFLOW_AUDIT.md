# Workflow Audit (Inherited from Upstream)

This document audits all workflows in `.github/workflows/` inherited from upstream (`can1357/oh-my-pi`), detailing triggers, secrets used, external services contacted, and operational compatibility with `MarsAI-org/mars-agent`.

---

## 1. `bun-cache-warm.yml` (Warm bun store cache)
- **Triggers**:
  - `push`: branches `[main]`, paths `["bun.lock", ".github/actions/bun-install/**", ".github/workflows/bun-cache-warm.yml"]`
  - `workflow_dispatch`
- **Secrets Used**: None.
- **External Services**: GitHub Actions Cache (`actions/cache`).
- **Compatibility**: Fully compatible with `MarsAI-org/mars-agent`. Runs on `ubuntu-22.04` using official/local actions.

---

## 2. `nix.yml` (Mars Nix)
- **Triggers**:
  - `push`: branches `[main]`, specific code/config paths
  - `pull_request`: branches `[main]`, specific code/config paths
- **Secrets Used**: None.
- **External Services**: Cachix / Nix public binary cache (`cachix/install-nix-action@v31`).
- **Compatibility**: Evaluates Nix flake checks on `ubuntu-22.04`. Notice: Evaluates checks without custom secrets.

---

## 3. `ci.yml` (CI / Main Pipeline)
- **Triggers**:
  - `push`: branches `[main]`, tags `v*`
  - `pull_request`: branches `[main]`
  - `workflow_dispatch`
- **Runner Infrastructure**:
  - Non-PR main runs originally used self-hosted runner `omp-kata`.
  - PR runs used `ubuntu-22.04`.
  - Matrix release/smoke jobs use GitHub-hosted runners (`ubuntu-22.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`, `windows-11-arm`).
- **Secrets Used**:
  - `secrets.APPLE_CERTIFICATE_P12`, `secrets.APPLE_CERTIFICATE_PASSWORD`, `secrets.APPLE_API_KEY_ID`, `secrets.APPLE_API_ISSUER_ID`, `secrets.APPLE_API_KEY` (macOS Developer ID signing & notarization). Falls back to ad-hoc codesign when unset.
  - `secrets.GITHUB_TOKEN` (Built-in GITHUB_TOKEN for release notes generation and GitHub Release creation).
- **External Services / Destinations**:
  - GitHub Releases (`MarsAI-org/mars-agent`): publishes standalone cross-platform binaries, browser-relay extension zip, license/notices, and `SHA256SUMS.txt`.
- **Compatibility & Removed Jobs**:
  - `release_npm` and `release_native_leaves`: Removed (Mars is distributed via GitHub Releases, not npmjs).
  - `release_brew`: Removed (no upstream Homebrew tap push).
  - A standalone manual fallback workflow is provided in `.github/workflows/release.yml` for emergency non-Bazel builds.
