# Domain Audit — Upstream Hosts vs. Mars Domain

Audit of all upstream-hosted domains (`omp.sh`, `my.omp.sh`, `live.omp.sh`, `qa.omp.sh`, `skills.omp.sh`) across the codebase.

Target official domain for Mars: **`getmars.eu.cc`** (base URL: `https://getmars.eu.cc`).

---

## 1. Classification Summary

Per rebrand policy:
- **STATIC**: Only serves static files (install scripts, schemas, documentation, package metadata, homepages). These **can and should** be repointed to `getmars.eu.cc` or repository/release URLs.
- **DYNAMIC**: Live server APIs, WebSocket relays, authentication/OIDC, or data ingestion endpoints (`collab`, `live`, `skills`, `qa/grievances`). These **must NOT** be repointed to `getmars.eu.cc` because no backend servers exist there; they retain TODO markers and will clearly fail or be gated.
- **UNKNOWN**: Non-standard or edge usage.

| Host / URL | Type | Description | Repoint Action |
| --- | --- | --- | --- |
| `https://omp.sh/` (`APP_URL`) | **STATIC** | Root website and base URL of the product | Repoint to `https://getmars.eu.cc/` (via `APP_URL` in `dirs.ts`) |
| `https://omp.sh/install` | **STATIC** | POSIX shell install script | Repoint to `https://getmars.eu.cc/install` |
| `https://omp.sh/install.ps1` | **STATIC** | PowerShell install script | Repoint to `https://getmars.eu.cc/install.ps1` |
| `https://omp.sh/schemas/*` | **STATIC** | JSON Schema IDs (`rpc-wire.json`) | Repoint to `https://getmars.eu.cc/schemas/*` |
| `https://omp.sh/docs/*` | **STATIC** | Documentation URLs referenced in comments | Repoint to `https://getmars.eu.cc/docs/*` or repo docs |
| `https://omp.sh` (metadata) | **STATIC** | `homepage` in `package.json`, `Cargo.toml`, Nix | Repoint to `https://getmars.eu.cc` |
| `https://omp.sh` (HTTP-Referer) | **STATIC** | OpenRouter edge cache request header (`APP_URL`) | Automatically repointed via `APP_URL` |
| `https://my.omp.sh` | **DYNAMIC** | Web collab client, WebSocket relay (`wss://my.omp.sh`), and session share (`/s`) | **DO NOT repoint** — keep TODO; server does not exist on getmars.eu.cc |
| `https://live.omp.sh` | **DYNAMIC** | Live streaming terminal broadcast & clip recording server (`/ws/host`, `/c/<id>`) | **DO NOT repoint** — keep TODO; server does not exist on getmars.eu.cc |
| `https://qa.omp.sh` | **DYNAMIC** | Auto QA grievance reporting API (`/v1/grievances`) | **DO NOT repoint** — keep TODO; server does not exist on getmars.eu.cc |
| `https://skills.omp.sh` | **DYNAMIC** | Skillshare registry API & OIDC audience | **DO NOT repoint** — keep TODO; server does not exist on getmars.eu.cc |

---

## 2. Detailed Audit Table with File:Line Evidence

### A. STATIC URLs (Eligible for repoint to `getmars.eu.cc`)

| File : Line | Upstream URL / Pattern | Classification | Notes |
| --- | --- | --- | --- |
| `packages/utils/src/dirs.ts:29` | `export const APP_URL: string = "https://omp.sh/";` | **STATIC** | Single source of truth for Mars base URL. Overridable via `MARS_APP_URL`. |
| `packages/coding-agent/src/cli/update-cli.ts:2199` | `https://omp.sh/install.ps1` | **STATIC** | Used in update-cli reinstall hint on Windows. |
| `packages/coding-agent/src/cli/update-cli.ts:2200` | `https://omp.sh/install` | **STATIC** | Used in update-cli reinstall hint on POSIX. |
| `packages/coding-agent/src/modes/rpc/wire/index.ts:197` | `https://omp.sh/schemas/rpc-wire.json` | **STATIC** | JSON Schema `$id` definition for RPC wire protocol. |
| `packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json:3` | `https://omp.sh/schemas/rpc-wire.json` | **STATIC** | Generated schema `$id`. |
| `packages/coding-agent/src/security/sarif.ts:32` | `informationUri: "https://omp.sh"` | **STATIC** | Tool metadata in SARIF reports. |
| `packages/coding-agent/src/commands/install.ts:5` | `omp.sh/docs/extension-authoring` | **STATIC** | Comment referencing extension docs. |
| `packages/coding-agent/src/discovery/builtin.ts:405` | `https://omp.sh/docs/context-files` | **STATIC** | Comment referencing context files docs. |
| `nix/package.nix:332` | `homepage = "https://omp.sh";` | **STATIC** | Nix package derivation homepage metadata. |
| `packages/ai/README.md:1090` | `[`mars`](https://omp.sh)` | **STATIC** | Link to product homepage. |
| `python/robomp/web/package.json:9` | `"homepage": "https://omp.sh"` | **STATIC** | robomp web package homepage metadata. |
| `sdk/python/omp-rpc/pyproject.toml:26` | `Homepage = "https://omp.sh/"` | **STATIC** | Python SDK package homepage metadata. |
| `scripts/rewrite-system-prompt.ts:420` | `"HTTP-Referer": "https://omp.sh/"` | **STATIC** | Direct referer string in test generator script. |
| `packages/collab-web/index.html:64` | `"url": "https://omp.sh/"` (`isPartOf.url`) | **STATIC** | Schema.org web site parent metadata. |
| `crates/pi-edit/tests/sloppy_parse.rs:365-366` | `https://omp.sh/a:3` | **STATIC** | Test fixture string for truncated parser output. (Keep as-is or safe fixture). |
| `packages/omptype/test/*` | `a@omp.sh`, `https://omp.sh` | **STATIC** | Unit test fixtures for schema URL validation. (Safe fixture). |
| `packages/tui/test/qrcode.test.ts:91` | `https://omp.sh/#demo` | **STATIC** | Test fixture for QR code rendering. (Safe fixture). |

---

### B. DYNAMIC URLs (Must NOT be repointed — retain TODO & clear failure)

| File : Line | Upstream URL / Host | Service Name | Reason / Behavior if Unreachable |
| --- | --- | --- | --- |
| `packages/wire/src/index.ts:426` | `DEFAULT_RELAY_URL = "wss://my.omp.sh"` | Collab Relay | WebSocket relay for live peer-to-peer session streaming. No relay backend deployed on getmars.eu.cc. |
| `packages/wire/src/index.ts:429` | `DEFAULT_SHARE_URL = "https://my.omp.sh/s"` | Session Share | HTTP upload for encrypted HTML session transcripts. Fails without active server. |
| `packages/collab-web/index.html:16,30,36,45,51,60` | `https://my.omp.sh/` | Collab Web App | Canonical URLs & OpenGraph metadata for the collab guest web client. |
| `packages/collab-web/public/robots.txt:5` | `https://my.omp.sh/sitemap.xml` | Collab Web App | Web client crawler sitemap. |
| `packages/collab-web/public/sitemap.xml:4` | `https://my.omp.sh/` | Collab Web App | Web client canonical URL. |
| `packages/collab-web/README.md:23,26,29` | `https://my.omp.sh`, `wss://my.omp.sh` | Collab Web App | Collab architecture and setup documentation. |
| `packages/collab-web/scripts/local-relay.ts:3` | `wss://my.omp.sh` | Collab Relay | Local mock relay doc comment. |
| `packages/wire/src/stream.ts:19` | `DEFAULT_STREAM_URL = "https://live.omp.sh"` | Mars Live | Twitch-style terminal streaming broadcast service. |
| `packages/coding-agent/src/cli/command-help.ts:38` | `live.omp.sh` | Mars Live | CLI help description for `mars clip`. |
| `packages/coding-agent/src/stream/clip-upload.ts:5` | `https://live.omp.sh` | Mars Live | Upload handler for public recordings (`.ompcast`). |
| `docs/stream.md:3,22,47,57,106,110,112` | `live.omp.sh` | Mars Live | Comprehensive live streaming docs. |
| `packages/catalog/src/compat/rules/auth/stencil.kdl:2` | `live.omp.sh` | Mars Live / Stencil | Auth descriptor comment. |
| `packages/coding-agent/src/tools/settings.ts:978,983` | `https://qa.omp.sh/v1/grievances` | Auto QA Grievances | Background grievance error reporting endpoint. |
| `packages/coding-agent/src/cli/grievances-cli.ts:210` | `qa.omp.sh/v1/grievances` | Auto QA Grievances | CLI handler doc comment for `mars grievances`. |
| `packages/coding-agent/src/tools/report-tool-issue.ts:25` | `qa.omp.sh` | Auto QA Grievances | Automatic QA issue telemetry reporter. |
| `packages/wire/src/skillshare.ts:19,73` | `https://skills.omp.sh`, audience `skills.omp.sh` | Skillshare | Skill registry client API & OIDC token audience. |
| `packages/coding-agent/src/cli/command-help.ts:137` | `skills.omp.sh` | Skillshare | CLI help description for `mars skill`. |
| `packages/coding-agent/src/commands/skill.ts:2` | `skills.omp.sh` | Skillshare | Command header doc comment. |
| `packages/coding-agent/src/skillshare/client.ts:94` | `skills.omp.sh` | Skillshare | HTTP client implementation. |
| `packages/coding-agent/src/slash-commands/builtin-skills.ts:19,68` | `skills.omp.sh` | Skillshare | Interactive slash command description. |
| `docs/cli-reference.md:251,279,297,298` | `live.omp.sh`, `skills.omp.sh` | Stream & Skills | CLI reference documentation. |
| `docs/collab.md:18,26,98,159,163,167` | `my.omp.sh`, `wss://my.omp.sh` | Collab & Share | Collab protocol documentation. |
| `docs/session-operations-export-share-fork-resume.md:121,175` | `my.omp.sh/s` | Share Server | Share documentation. |
| `docs/user-facing-packages.md:92,95` | `my.omp.sh` | Collab Web App | Package overview documentation. |
| `ASSETS_TODO.md:115` | `https://my.omp.sh/og-image.png` | Collab Web App | Social preview artwork TODO. |
