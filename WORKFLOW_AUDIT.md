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
  - `workflow_dispatch`: inputs `skip_npm`, `skip_native_leaves`, `release_targets`
- **Runner Infrastructure**:
  - Non-PR main runs originally used self-hosted runner `omp-kata`.
  - PR runs used `ubuntu-22.04`.
  - Matrix release/smoke jobs use GitHub-hosted runners (`ubuntu-22.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`, `windows-11-arm`).
- **Secrets Used**:
  - `secrets.APPLE_CERTIFICATE_P12`, `secrets.APPLE_CERTIFICATE_PASSWORD`, `secrets.APPLE_API_KEY_ID`, `secrets.APPLE_API_ISSUER_ID`, `secrets.APPLE_API_KEY` (macOS Developer ID signing & notarization). Falls back to ad-hoc codesign when unset.
  - `secrets.NPM_TOKEN` (npm publishing fallback in `release_native_leaves` and `release_npm`).
  - `secrets.HOMEBREW_TAP_DEPLOY_KEY` (Homebrew tap formula push in `release_brew`).
  - `secrets.GITHUB_TOKEN` (Built-in GITHUB_TOKEN for release notes generation and GitHub Release creation).
- **External Services / Destinations**:
  - `npm` (`registry.npmjs.org`): publishes `@marsai-org/*` packages.
  - Homebrew tap (`can1357/homebrew-tap`): pushes updated formula.
  - Upstream domains (`omp-kata` runner cluster, `can1357/homebrew-tap`).
- **Compatibility & Disabling of Incompatible / Secret-Dependent Jobs**:
  - `release_npm`: Incompatible until `@marsai-org` npm organization / Trusted Publishing is configured. Disabled safely via `if: github.repository == 'MarsAI-org/mars-agent' && false`.
  - `release_native_leaves`: Incompatible until npm packages exist. Disabled safely via `if: github.repository == 'MarsAI-org/mars-agent' && false`.
  - `release_brew`: Incompatible because it targets upstream `can1357/homebrew-tap` with missing SSH key. Disabled safely via `if: github.repository == 'MarsAI-org/mars-agent' && false`.
  - A standalone release workflow is provided in `.github/workflows/release.yml` for dedicated release orchestration without private cluster runners.
