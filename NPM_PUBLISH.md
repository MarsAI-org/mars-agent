# Publishing the `@marsai-org` packages to npm

This document is the operator's guide for the first and subsequent publishes of
the workspace packages. It is written for a human at a keyboard; the automated
paths live in `.github/workflows/npm-publish.yml` (token bootstrap) and
`.github/workflows/npm-publish-trusted.yml` (OIDC trusted publishing).

Nothing in this repository ever reads, prints, or stores a registry credential.
Every workflow references the token by name only (`secrets.NPM_TOKEN`) and the
publish step is the only step whose environment carries it.

---

## 1. What gets published

### Publishable workspace packages (12)

| Package | Directory | `bin` | Notes |
|---|---|---|---|
| `@marsai-org/omptype` | `packages/omptype` | — | ships transpiled JS (`dist/js`) so it runs on plain Node |
| `@marsai-org/wire` | `packages/wire` | — | types only |
| `@marsai-org/utils` | `packages/utils` | — | depends on `natives` |
| `@marsai-org/catalog` | `packages/catalog` | — | bundles `models.json` + `compat/rules.json` |
| `@marsai-org/natives` | `packages/natives` | — | native **core**: JS wrapper only, no `.node` |
| `@marsai-org/ai` | `packages/ai` | — | |
| `@marsai-org/snapcompact` | `packages/snapcompact` | — | |
| `@marsai-org/mnemopi` | `packages/mnemopi` | `mnemopi` | |
| `@marsai-org/stats` | `packages/stats` | `mars-stats` | ships `dist/client` dashboard |
| `@marsai-org/agent-core` | `packages/agent` | — | |
| `@marsai-org/tui` | `packages/tui` | — | |
| `@marsai-org/coding-agent` | `packages/coding-agent` | `mars` | `bin` is repointed to `dist/cli.js` |

### Platform-specific native leaf packages (6)

Generated at publish time by `packages/natives/scripts/gen-npm-packages.ts` from
the `.node` artifacts in `packages/natives/native/`:

`@marsai-org/natives-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`,
`-win32-x64`, `-win32-arm64`.

Each leaf declares `os` and `cpu`, and `@marsai-org/natives` declares all six as
`optionalDependencies` at the same version, so a consumer installs exactly one.
The leaves are published by `bun run ci:release:publish-native-leaf <tag>` and
must be published **before** the core `@marsai-org/natives`.

### Not published (private)

`@marsai-org/browser-relay`, `@marsai-org/collab-web`,
`@marsai-org/metaharness`, `@marsai-org/typescript-edit-benchmark`, and
`robomp-web` all set `"private": true` and are skipped by the publish script.

---

## 2. Metadata contract

Verified for every publishable package:

- **Name**: all under the `@marsai-org` scope.
- **Version**: one consistent version across the workspace (see §3).
- **License**: `MIT`, and every manifest declares `"publishConfig": { "access": "public" }`.
  The workflows also pass `--access public` explicitly; the manifest field makes a
  manual `npm publish` from a package directory correct as well.
- **`repository` / `homepage` / `bugs`**: point at
  `github.com/MarsAI-org/mars-agent`. Trusted publishing requires `repository.url`
  to match the publishing repository exactly — it does.
- **`bin`**: declared for `coding-agent` (`mars`), `mnemopi`, and `stats`. The
  publish script rewrites `coding-agent`'s `bin` to the prepack bundle
  (`src/cli.ts` → `dist/cli.js`) so the published package runs without a build.
- **`files`**: source + `README.md` + `CHANGELOG.md` for source-runtime packages;
  `dist/types` is added at publish time. The legal payload (`LICENSE`,
  `CREDITS.md`, `THIRD-PARTY-NOTICES.txt`) is staged into every package and added
  to `files` by the publish script.
- **`os` / `cpu`**: declared on the six native **leaf** packages. The native
  **core** deliberately declares neither — it is the platform-independent
  wrapper, and the leaves carry the platform constraint.
- **`optionalDependencies`**: the native core gets the six leaves at publish time.
- **Name availability**: a `GET https://registry.npmjs.org/@marsai-org%2F<name>`
  returns HTTP 404 for all twelve, i.e. none of them is published yet.
  Whether the `@marsai-org` scope itself exists on npm is **UNVERIFIED** here:
  `npmjs.com` returns HTTP 403 for both a real org page and this one, so the
  check is inconclusive from this environment. The first publish will settle it.

---

## 3. Version policy (decision DEC-16)

**One version for the whole workspace, kept at the inherited `18.8.6`.**

The requirement is a single consistent version across all packages, which the
workspace already satisfies. Resetting to `0.1.0` was considered and rejected:

- `packages/natives/package.json#version` is stamped into the compiled addon at
  link time (`scripts/stamp-native-version.ts`, slot read by
  `__piNativesBuildVersion()`). Changing the version without rebuilding every
  addon leaves the shipped binaries carrying the old identity.
- The version also appears in `Cargo.toml`, the root `package.json` catalog pins,
  all twelve manifests, and `bun.lock` — a wide, mechanical change for no
  functional gain.
- Nothing in the test suite asserts the version, so a reset would not be caught
  by tests either way.

A future deliberate renumbering should be its own change with a native rebuild.

---

## 4. Publish order

The publish script derives the order from each manifest's workspace
dependencies, so it is not hand-maintained. The resulting order is:

1. `@marsai-org/wire`, `@marsai-org/omptype`
2. `@marsai-org/natives` (core, after its six leaves)
3. `@marsai-org/utils`
4. `@marsai-org/catalog`
5. `@marsai-org/ai`
6. `@marsai-org/mnemopi`, `@marsai-org/snapcompact`, `@marsai-org/stats`
7. `@marsai-org/agent-core`
8. `@marsai-org/tui`
9. `@marsai-org/coding-agent`

Packages whose dependencies have not published are held back rather than
published against a missing version. Packing starts immediately; publishing is
gated on prerequisites. The script packs into a private temp directory and skips
any version that a registry `GET` already reports, so re-runs are idempotent.

## 5. dist-tag policy

- The bootstrap publish uses **`next`**. `latest` is left untouched on purpose:
  moving `latest` is a deliberate human action (`npm dist-tag add`), not a side
  effect of a first publish.
- `--dist-tag <tag>` overrides the version-derived default. Without an override
  the script derives `latest` for a stable version, `canary` for
  `x.y.z-canary.N`, and **refuses** any other prerelease rather than silently
  publishing it on the stable channel.
- Under trusted publishing, dist-tag management needs npm ≥ 11.21.0 and the
  "Allow npm dist-tag" option on the package's trusted-publisher configuration.

## 6. Running the publish

### Token bootstrap — `.github/workflows/npm-publish.yml`

`workflow_dispatch` only (plus `v*` tag pushes on `main`); never triggered by a
pull request. Inputs: `dry_run` (default `true`) and `dist_tag` (default `next`).

The job runs only from `main` or a `v*` tag. Install, native build, and workspace
build run first, with no secret in their environment. A single publish step then
reports `NPM_TOKEN: present|missing` (a `test -n`, never the value) and
`npm whoami`, and publishes with
`--provenance --access public --tag <dist_tag> --ignore-scripts`.

### Trusted publishing — `.github/workflows/npm-publish-trusted.yml`

`workflow_dispatch` only, **no token at all**: authentication is the GitHub OIDC
token (`id-token: write`). Requires npm ≥ 11.5.1 and Node ≥ 22.14; provenance is
generated automatically. This workflow is **inactive until a human configures a
Trusted Publisher for each package** on npmjs.com (package → Settings → Trusted
publishing): organization `MarsAI-org`, repository `mars-agent`, workflow
filename `npm-publish-trusted.yml`.

> A new trusted-publisher configuration expires if it does not complete its first
> successful publish within 2 days. Configure it when you are ready to publish.

## 7. Human steps after the first publish

1. **Verify** each package: `npm view @marsai-org/<name> dist-tags versions`.
2. **Move `latest`** when the release is ready: `npm dist-tag add @marsai-org/<name>@<version> latest`.
3. **Configure Trusted Publisher** for every package, then switch to
   `npm-publish-trusted.yml`.
4. **Revoke the bootstrap token and delete the `NPM_TOKEN` repository secret.**
   Prefer "Require two-factor authentication and disallow tokens" on each package
   once trusted publishing is validated.
5. If the leaf packages were not published, publish them before the core:
   `bun run ci:release:publish-native-leaf <tag>` for each of the six tags.

## 8. Notes and known hazards

- **`ci.yml` already contains the release/publish jobs, disabled.** The jobs
  `release_native_leaves`, `release_npm`, and `release_brew` carry an
  `if: github.repository == 'MarsAI-org/mars-agent' && false` guard and never
  run. They were disabled because the npm org and tokens did not exist. The
  workflows described here are the supported path; re-enabling the `ci.yml` jobs
  is a separate decision that must come with the same hygiene review.
- **The root `publish` / `publish:dry` scripts now delegate** to
  `scripts/ci-release-publish.ts`. The previous `npm publish -ws` invocation
  bypassed the manifest rewrite and would have packed
  `packages/natives/native/*.node` (a ~225 MB addon) and unbuilt TypeScript
  sources into the published tarballs.
- **Package sizes** were measured with `bun pm pack --dry-run`. After the publish
  rewrite the largest payloads are the `coding-agent` CLI bundle (~30 MB
  unpacked) and `catalog`'s `models.json` (~12 MB). No package contains a secret,
  a test fixture, `node_modules`, or a stray `.env`.
