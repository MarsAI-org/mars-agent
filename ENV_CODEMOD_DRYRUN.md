# ENV_CODEMOD — applied

Generated: 2026-10-09T12:02:23+00:00
Mode: apply
Rule: \bOMP_[A-Z0-9_]*\b -> MARS_<suffix>

## Summary

- files scanned: 8840
- files touched: 221
- total edits: 918
- excluded files skipped: 32

### Excluded (kept MARS_* on purpose)

- `ENV_CODEMOD_DRYRUN.md`
- `ENV_RENAME_MAP.md`
- `HANDOFF.md`
- `REBRAND_AUDIT.md`
- `REBRAND_CODEMOD_DRYRUN.md`
- `bun.lock`
- `crates/pi-natives/data/cl100k_base.bin.zst`
- `crates/pi-natives/data/ctok_v3.bin.zst`
- `crates/pi-natives/data/ctok_v4_7.bin.zst`
- `crates/pi-natives/data/deepseek3.bin.zst`
- `crates/pi-natives/data/glm5.bin.zst`
- `crates/pi-natives/data/jev_base.bin.zst`
- `crates/pi-natives/data/jev_whole.bin.zst`
- `crates/pi-natives/data/kimi_k2.bin.zst`
- `crates/pi-natives/data/o200k_base.bin.zst`
- `crates/pi-natives/data/qwen3.bin.zst`
- `crates/pi-predict/data/web-prior.bin.zst`
- `crates/vendor/napi/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/ai/CHANGELOG.md`
- `packages/browser-relay/CHANGELOG.md`
- `packages/catalog/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/collab-web/CHANGELOG.md`
- `packages/mnemopi/CHANGELOG.md`
- `packages/natives/CHANGELOG.md`
- `packages/omptype/CHANGELOG.md`
- `packages/snapcompact/CHANGELOG.md`
- `packages/stats/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`
- `packages/utils/CHANGELOG.md`
- `packages/wire/CHANGELOG.md`

### Per-file detail

#### .github/actions

- `.github/actions/bazel-cache/action.yml`
  - `OMP_XWIN_CACHE_DIR -> MARS_XWIN_CACHE_DIR`

#### .github/workflows

- `.github/workflows/ci.yml`
  - `OMP_INSTALL_TEST_SKIP_NATIVE_BUILD -> MARS_INSTALL_TEST_SKIP_NATIVE_BUILD`
  - `OMP_TEST_CONCURRENCY -> MARS_TEST_CONCURRENCY` x5
  - `OMP_TEST_SHARD -> MARS_TEST_SHARD`
  - `OMP_TEST_TIMEOUT -> MARS_TEST_TIMEOUT`

#### .omp/tools

- `.omp/tools/tui.ts`
  - `OMP_TUI_DEBUG -> MARS_TUI_DEBUG` x4

#### Dockerfile

- `Dockerfile`
  - `OMP_NATIVE_CARGO_PROFILE -> MARS_NATIVE_CARGO_PROFILE`

#### bazel/toolchains

- `bazel/toolchains/msvc/sysroot.bzl`
  - `OMP_XWIN_CACHE_DIR -> MARS_XWIN_CACHE_DIR` x4
- `bazel/toolchains/swift/applefm.bzl`
  - `OMP_APPLEFM_SWIFTC -> MARS_APPLEFM_SWIFTC`

#### crates/pi-builtins

- `crates/pi-builtins/src/grep.rs`
  - `OMP_PCRE2_JIT -> MARS_PCRE2_JIT` x2
- `crates/pi-builtins/src/nproc.rs`
  - `OMP_NUM_THREADS -> MARS_NUM_THREADS` x10
  - `OMP_THREAD_LIMIT -> MARS_THREAD_LIMIT` x3
- `crates/pi-builtins/src/rg.rs`
  - `OMP_PCRE2_JIT -> MARS_PCRE2_JIT`

#### crates/pi-natives

- `crates/pi-natives/BUILD.bazel`
  - `OMP_APPLEFM_BRIDGE -> MARS_APPLEFM_BRIDGE`
  - `OMP_CAPTURE_DARWIN_HELPER -> MARS_CAPTURE_DARWIN_HELPER`
  - `OMP_OAUTH_DARWIN_HELPER -> MARS_OAUTH_DARWIN_HELPER`
  - `OMP_OAUTH_RELAY_BINARY -> MARS_OAUTH_RELAY_BINARY`
  - `OMP_SYNTAX_SET -> MARS_SYNTAX_SET` x2
- `crates/pi-natives/build.rs`
  - `OMP_APPLEFM_BRIDGE -> MARS_APPLEFM_BRIDGE` x2
  - `OMP_APPLEFM_MODULE_CACHE -> MARS_APPLEFM_MODULE_CACHE`
  - `OMP_APPLEFM_SWIFTC -> MARS_APPLEFM_SWIFTC`
  - `OMP_CAPTURE_DARWIN_HELPER -> MARS_CAPTURE_DARWIN_HELPER`
  - `OMP_OAUTH_DARWIN_HELPER -> MARS_OAUTH_DARWIN_HELPER`
  - `OMP_OAUTH_RELAY_BINARY -> MARS_OAUTH_RELAY_BINARY`
  - `OMP_SYNTAX_SET -> MARS_SYNTAX_SET`
- `crates/pi-natives/src/applefm/build-bridge.sh`
  - `OMP_APPLEFM_MODULE_CACHE -> MARS_APPLEFM_MODULE_CACHE` x2
  - `OMP_APPLEFM_SWIFTC -> MARS_APPLEFM_SWIFTC` x2
- `crates/pi-natives/src/applefm/mod.rs`
  - `OMP_APPLEFM_BRIDGE -> MARS_APPLEFM_BRIDGE`
- `crates/pi-natives/src/desktop/macos/capture/screen_capture_kit.rs`
  - `OMP_CAPTURE_DARWIN_HELPER -> MARS_CAPTURE_DARWIN_HELPER`
- `crates/pi-natives/src/grep.rs`
  - `OMP_PCRE2_JIT -> MARS_PCRE2_JIT` x2
- `crates/pi-natives/src/highlight.rs`
  - `OMP_SYNTAX_SET -> MARS_SYNTAX_SET`
- `crates/pi-natives/src/oauth_callback/mod.rs`
  - `OMP_OAUTH_DARWIN_HELPER -> MARS_OAUTH_DARWIN_HELPER`
  - `OMP_OAUTH_RELAY_BINARY -> MARS_OAUTH_RELAY_BINARY`
- `crates/pi-natives/src/shell.rs`
  - `OMP_MINIMIZER_LEGACY_FILTERS -> MARS_MINIMIZER_LEGACY_FILTERS`

#### crates/pi-shell

- `crates/pi-shell/src/minimizer/config.rs`
  - `OMP_MINIMIZER_LEGACY_FILTERS -> MARS_MINIMIZER_LEGACY_FILTERS` x4
- `crates/pi-shell/src/shell.rs`
  - `OMP_DECLARE_RO -> MARS_DECLARE_RO` x2
  - `OMP_GIT_ENV_PROBE -> MARS_GIT_ENV_PROBE` x2
- `crates/pi-shell/tests/nonutf8_env.rs`
  - `OMP_TEST_CORRUPT_8925 -> MARS_TEST_CORRUPT_8925` x2
  - `OMP_TEST_SENTINEL_8925 -> MARS_TEST_SENTINEL_8925` x2

#### crates/pi-voice

- `crates/pi-voice/src/audio.rs`
  - `OMP_NATIVE_AUDIO_CAPTURE_TEST -> MARS_NATIVE_AUDIO_CAPTURE_TEST`
  - `OMP_NATIVE_AUDIO_PLAYBACK_TEST -> MARS_NATIVE_AUDIO_PLAYBACK_TEST`

#### crates/vendor

- `crates/vendor/brush-core/src/sys/unix/env.rs`
  - `OMP_TEST_BAD_KEY -> MARS_TEST_BAD_KEY`
  - `OMP_TEST_BAD_VALUE_8925 -> MARS_TEST_BAD_VALUE_8925` x3
  - `OMP_TEST_KEEP_8925 -> MARS_TEST_KEEP_8925` x3

#### docs/ERRATA-GPT5-HARMONY.md

- `docs/ERRATA-GPT5-HARMONY.md`
  - `OMP_HARMONY_DEBUG -> MARS_HARMONY_DEBUG`

#### docs/auth-broker-gateway.md

- `docs/auth-broker-gateway.md`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` x2
  - `OMP_AUTH_BROKER_SNAPSHOT_CACHE -> MARS_AUTH_BROKER_SNAPSHOT_CACHE`
  - `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS -> MARS_AUTH_BROKER_SNAPSHOT_TTL_MS` x2
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x5
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x7

#### docs/cli-reference.md

- `docs/cli-reference.md`
  - `OMP_PROFILE -> MARS_PROFILE`

#### docs/config-usage.md

- `docs/config-usage.md`
  - `OMP_PROFILE -> MARS_PROFILE` x2

#### docs/context-files.md

- `docs/context-files.md`
  - `OMP_PROFILE -> MARS_PROFILE`

#### docs/environment-variables.md

- `docs/environment-variables.md`
  - `OMP_ -> MARS_`
  - `OMP_AUTH_BROKER_ -> MARS_AUTH_BROKER_`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE`
  - `OMP_AUTH_BROKER_SNAPSHOT_CACHE -> MARS_AUTH_BROKER_SNAPSHOT_CACHE`
  - `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS -> MARS_AUTH_BROKER_SNAPSHOT_TTL_MS`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
  - `OMP_AUTORESEARCH_DB_DIR -> MARS_AUTORESEARCH_DB_DIR`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS`
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB`
  - `OMP_LOG_LEVEL -> MARS_LOG_LEVEL`
  - `OMP_MCP_REQUIRE_READY -> MARS_MCP_REQUIRE_READY`
  - `OMP_MCP_STARTUP_TIMEOUT_MS -> MARS_MCP_STARTUP_TIMEOUT_MS`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
  - `OMP_NO_WEBP -> MARS_NO_WEBP`
  - `OMP_PROFILE -> MARS_PROFILE` x2
  - `OMP_SKIP_SETUP -> MARS_SKIP_SETUP`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR`

#### docs/local-models.md

- `docs/local-models.md`
  - `OMP_NATIVE_LIBRARY_PATH -> MARS_NATIVE_LIBRARY_PATH`
  - `OMP_TINY_WORKER_IDLE_MS -> MARS_TINY_WORKER_IDLE_MS`

#### docs/macos-signing-notarization.md

- `docs/macos-signing-notarization.md`
  - `OMP_REPO -> MARS_REPO`
  - `OMP_SIGNING_DIR -> MARS_SIGNING_DIR`

#### docs/mcp-config.md

- `docs/mcp-config.md`
  - `OMP_MCP_REQUIRE_READY -> MARS_MCP_REQUIRE_READY`
  - `OMP_MCP_STARTUP_TIMEOUT_MS -> MARS_MCP_STARTUP_TIMEOUT_MS`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x3
  - `OMP_PROFILE -> MARS_PROFILE`

#### docs/mcp-protocol-transports.md

- `docs/mcp-protocol-transports.md`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x3

#### docs/mcp-runtime-lifecycle.md

- `docs/mcp-runtime-lifecycle.md`
  - `OMP_MCP_REQUIRE_READY -> MARS_MCP_REQUIRE_READY`
  - `OMP_MCP_STARTUP_TIMEOUT_MS -> MARS_MCP_STARTUP_TIMEOUT_MS`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x3

#### docs/mcp-server-tool-authoring.md

- `docs/mcp-server-tool-authoring.md`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`

#### docs/models.md

- `docs/models.md`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2

#### docs/natives-build-release-debugging.md

- `docs/natives-build-release-debugging.md`
  - `OMP_BAZEL_RC -> MARS_BAZEL_RC` x2
  - `OMP_NATIVE_BUILD_BACKEND -> MARS_NATIVE_BUILD_BACKEND` x3
  - `OMP_NATIVE_CARGO_PROFILE -> MARS_NATIVE_CARGO_PROFILE`
  - `OMP_NATIVE_FEATURES -> MARS_NATIVE_FEATURES` x2

#### docs/natives-text-search-pipeline.md

- `docs/natives-text-search-pipeline.md`
  - `OMP_PCRE2_JIT -> MARS_PCRE2_JIT`

#### docs/porting-to-natives.md

- `docs/porting-to-natives.md`
  - `OMP_NATIVE_BUILD_BACKEND -> MARS_NATIVE_BUILD_BACKEND`

#### docs/providers.md

- `docs/providers.md`
  - `OMP_ -> MARS_`

#### docs/settings.md

- `docs/settings.md`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x2
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
  - `OMP_PROFILE -> MARS_PROFILE` x5

#### docs/tools

- `docs/tools/github.md`
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x2
- `docs/tools/task.md`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`

#### infra/docs

- `infra/docs/04-arc-and-caching.md`
  - `OMP_NATIVE_CACHE_DIR -> MARS_NATIVE_CACHE_DIR`
  - `OMP_XWIN_CACHE_DIR -> MARS_XWIN_CACHE_DIR`

#### nix/package.nix

- `nix/package.nix`
  - `OMP_NATIVE_LIBRARY_PATH -> MARS_NATIVE_LIBRARY_PATH` x3

#### packages/ai

- `packages/ai/src/auth-broker/discover.ts`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` x8
  - `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS -> MARS_AUTH_BROKER_SNAPSHOT_TTL_MS` x2
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x3
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x3
- `packages/ai/src/utils/harmony-leak.ts`
  - `OMP_HARMONY_DEBUG -> MARS_HARMONY_DEBUG`
- `packages/ai/test/auth-broker-config-discovery.test.ts`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` x3
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x3
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x3
- `packages/ai/test/auth-broker-nested-config.test.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/ai/test/auth-broker-remote-store.test.ts`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` x2
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x2
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
- `packages/ai/test/auth-gateway-anthropic-caching.test.ts`
  - `OMP_E2E_ANTHROPIC_MODEL -> MARS_E2E_ANTHROPIC_MODEL`
  - `OMP_E2E_GATEWAY_URL -> MARS_E2E_GATEWAY_URL`
- `packages/ai/test/auth-gateway-anthropic-to-codex-caching.test.ts`
  - `OMP_E2E_CODEX_MODEL -> MARS_E2E_CODEX_MODEL`
  - `OMP_E2E_GATEWAY_URL -> MARS_E2E_GATEWAY_URL`
- `packages/ai/test/auth-gateway-cross-protocol-caching.test.ts`
  - `OMP_E2E_ANTHROPIC_MODEL -> MARS_E2E_ANTHROPIC_MODEL`
  - `OMP_E2E_GATEWAY_URL -> MARS_E2E_GATEWAY_URL`
- `packages/ai/test/auth-gateway-openai-responses-caching.test.ts`
  - `OMP_E2E_GATEWAY_URL -> MARS_E2E_GATEWAY_URL`
  - `OMP_E2E_OPENAI_RESPONSES_MODEL -> MARS_E2E_OPENAI_RESPONSES_MODEL`
- `packages/ai/test/helpers/index.ts`
  - `OMP_E2E_GATEWAY_URL -> MARS_E2E_GATEWAY_URL`

#### packages/catalog

- `packages/catalog/scripts/generate-models.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2

#### packages/coding-agent

- `packages/coding-agent/scripts/mars`
  - `OMP_DEV_LAUNCH_DIR -> MARS_DEV_LAUNCH_DIR`
  - `OMP_LAUNCH_CWD -> MARS_LAUNCH_CWD` x2
- `packages/coding-agent/scripts/mars.ts`
  - `OMP_LAUNCH_CWD -> MARS_LAUNCH_CWD` x2
- `packages/coding-agent/src/autoresearch/storage.ts`
  - `OMP_AUTORESEARCH_DB_DIR -> MARS_AUTORESEARCH_DB_DIR`
- `packages/coding-agent/src/blob-broker/protocol.ts`
  - `OMP_BLOB_BROKER_CONFIG -> MARS_BLOB_BROKER_CONFIG`
  - `OMP_BLOB_BROKER_SOCKET -> MARS_BLOB_BROKER_SOCKET`
- `packages/coding-agent/src/cli.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x5
  - `OMP_TINY_WORKER_SOCKET -> MARS_TINY_WORKER_SOCKET`
- `packages/coding-agent/src/cli/auth-broker-cli.ts`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
- `packages/coding-agent/src/cli/auth-gateway-cli.ts`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x4
- `packages/coding-agent/src/cli/help-extra.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/src/cli/usage-cli.ts`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/coding-agent/src/config/model-settings.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/coding-agent/src/discovery/claude-plugins.ts`
  - `OMP_PLUGIN_ROOT -> MARS_PLUGIN_ROOT` x3
- `packages/coding-agent/src/discovery/omp-plugins.ts`
  - `OMP_PLUGIN_ROOT -> MARS_PLUGIN_ROOT`
- `packages/coding-agent/src/discovery/substitute-plugin-root.ts`
  - `OMP_PLUGIN_ROOT -> MARS_PLUGIN_ROOT` x2
  - `OMP_VAR -> MARS_VAR` x2
- `packages/coding-agent/src/ida/protocol.ts`
  - `OMP_IDA_HOST_CONFIG -> MARS_IDA_HOST_CONFIG`
- `packages/coding-agent/src/launch/protocol.ts`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS`
  - `OMP_DAEMON_PROJECT_DIR -> MARS_DAEMON_PROJECT_DIR`
  - `OMP_DAEMON_RUNTIME_DIR -> MARS_DAEMON_RUNTIME_DIR`
- `packages/coding-agent/src/lsp/mux/protocol.ts`
  - `OMP_LSP_MUX_PROJECT_DIR -> MARS_LSP_MUX_PROJECT_DIR`
  - `OMP_LSP_MUX_SOCKET -> MARS_LSP_MUX_SOCKET`
- `packages/coding-agent/src/mcp/client.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
- `packages/coding-agent/src/mcp/manager.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
- `packages/coding-agent/src/mcp/timeout.ts`
  - `OMP_MCP_STARTUP_TIMEOUT_MS -> MARS_MCP_STARTUP_TIMEOUT_MS` x2
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x2
- `packages/coding-agent/src/mcp/transports/header-policy.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
- `packages/coding-agent/src/mcp/transports/http.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
- `packages/coding-agent/src/mnemopi/embed-client.ts`
  - `OMP_ -> MARS_`
- `packages/coding-agent/src/modes/controllers/input-controller.ts`
  - `OMP_STATUS_LINE_RE -> MARS_STATUS_LINE_RE` x2
- `packages/coding-agent/src/modes/print-mode.ts`
  - `OMP_MCP_REQUIRE_READY -> MARS_MCP_REQUIRE_READY`
- `packages/coding-agent/src/predict/protocol.ts`
  - `OMP_TEXT_PREDICT_AGENT_DIR -> MARS_TEXT_PREDICT_AGENT_DIR`
  - `OMP_TEXT_PREDICT_SOCKET -> MARS_TEXT_PREDICT_SOCKET`
- `packages/coding-agent/src/sdk.ts`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/coding-agent/src/security/provenance.ts`
  - `OMP_SECURITY_WORKFLOW_VERSION -> MARS_SECURITY_WORKFLOW_VERSION` x3
- `packages/coding-agent/src/session/auth-broker-config.ts`
  - `OMP_AUTH_BROKER_ -> MARS_AUTH_BROKER_`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x3
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x3
- `packages/coding-agent/src/session/redis-session-storage.ts`
  - `OMP_APPEND -> MARS_APPEND`
  - `OMP_UPDATE_TITLE -> MARS_UPDATE_TITLE`
  - `OMP_WRITE_FULL -> MARS_WRITE_FULL`
- `packages/coding-agent/src/subprocess/worker-client.ts`
  - `OMP_NATIVE_LIBRARY_PATH -> MARS_NATIVE_LIBRARY_PATH` x2
- `packages/coding-agent/src/task/settings.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR`
- `packages/coding-agent/src/tiny/title-protocol.ts`
  - `OMP_TINY_WORKER_IDLE_MS -> MARS_TINY_WORKER_IDLE_MS`
  - `OMP_TINY_WORKER_MODEL -> MARS_TINY_WORKER_MODEL`
  - `OMP_TINY_WORKER_SOCKET -> MARS_TINY_WORKER_SOCKET`
  - `OMP_TINY_WORKER_TAG -> MARS_TINY_WORKER_TAG`
- `packages/coding-agent/src/tools/browser/tab-protocol.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP`
- `packages/coding-agent/src/utils/image-loading.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP` x2
- `packages/coding-agent/src/utils/image-resize.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP` x5
- `packages/coding-agent/src/web/search/index.ts`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/coding-agent/test/acp-builtins.test.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x12
- `packages/coding-agent/test/advisor-toggle.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x3
- `packages/coding-agent/test/agent-session-bash-session-ownership.test.ts`
  - `OMP_INJECTED_TOKEN -> MARS_INJECTED_TOKEN` x4
  - `OMP_USER_SHELL_ENV -> MARS_USER_SHELL_ENV` x3
  - `OMP_USER_SHELL_MIRROR -> MARS_USER_SHELL_MIRROR` x6
- `packages/coding-agent/test/agent-storage-model-perf.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/auth-broker-import.test.ts`
  - `OMP_AGENT_DIR -> MARS_AGENT_DIR` x3
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x8
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x8
- `packages/coding-agent/test/auth-broker-live-settings.test.ts`
  - `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS -> MARS_AUTH_BROKER_SNAPSHOT_TTL_MS` x2
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN`
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL`
- `packages/coding-agent/test/auth-broker-migrate.test.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x4
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x4
- `packages/coding-agent/test/auth-broker-snapshot-cache.test.ts`
  - `OMP_AUTH_BROKER_SNAPSHOT_CACHE -> MARS_AUTH_BROKER_SNAPSHOT_CACHE` x4
  - `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS -> MARS_AUTH_BROKER_SNAPSHOT_TTL_MS` x4
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x4
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x4
- `packages/coding-agent/test/auth-gateway-account-pool.test.ts`
  - `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE -> MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` x2
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x2
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
- `packages/coding-agent/test/autoresearch-before-agent-start.test.ts`
  - `OMP_AUTORESEARCH_DB_DIR -> MARS_AUTORESEARCH_DB_DIR` x2
- `packages/coding-agent/test/autoresearch-state.test.ts`
  - `OMP_AUTORESEARCH_DB_DIR -> MARS_AUTORESEARCH_DB_DIR` x4
- `packages/coding-agent/test/autoresearch-tools.test.ts`
  - `OMP_AUTORESEARCH_DB_DIR -> MARS_AUTORESEARCH_DB_DIR` x8
- `packages/coding-agent/test/cli-unsettled-command.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/cli/worktree-clear-isolation.test.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x4
- `packages/coding-agent/test/collab/controller.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/collab/helpers/registry-host-process.ts`
  - `OMP_SMOKE_INSTANCE_ID -> MARS_SMOKE_INSTANCE_ID` x2
  - `OMP_SMOKE_MARKER -> MARS_SMOKE_MARKER` x2
- `packages/coding-agent/test/collab/registry-smoke.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
  - `OMP_SMOKE_INSTANCE_ID -> MARS_SMOKE_INSTANCE_ID`
  - `OMP_SMOKE_MARKER -> MARS_SMOKE_MARKER`
- `packages/coding-agent/test/debug/dap-config.test.ts`
  - `OMP_MARKETPLACE_DIR -> MARS_MARKETPLACE_DIR` x4
  - `OMP_PLUGIN_DIR -> MARS_PLUGIN_DIR` x4
- `packages/coding-agent/test/direnv.test.ts`
  - `OMP_DIRENV_TEST_ -> MARS_DIRENV_TEST_`
- `packages/coding-agent/test/discovery/builtin-home-walkup.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/discovery/builtin-tools.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/discovery/claude-plugins.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/discovery/disabled-extensions.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/discovery/opencode.test.ts`
  - `OMP_TEST_MCP_ABSENT -> MARS_TEST_MCP_ABSENT` x2
  - `OMP_TEST_MCP_KEY -> MARS_TEST_MCP_KEY` x3
  - `OMP_TEST_MCP_PATH -> MARS_TEST_MCP_PATH` x3
- `packages/coding-agent/test/eval/context-manager-startup.test.ts`
  - `OMP_EVAL_HOST_EXECUTION_ -> MARS_EVAL_HOST_EXECUTION_`
- `packages/coding-agent/test/eval/process-entry-import.test.ts`
  - `OMP_PROCESS_ENTRY_ENV_PROBE -> MARS_PROCESS_ENTRY_ENV_PROBE` x2
- `packages/coding-agent/test/fatal-stderr-pty.test.ts`
  - `OMP_TUI_DEBUG -> MARS_TUI_DEBUG`
  - `OMP_TUI_NATIVE -> MARS_TUI_NATIVE`
- `packages/coding-agent/test/fixtures/browser-executable-probe.ts`
  - `OMP_BROWSER_PROBE_PLATFORM -> MARS_BROWSER_PROBE_PLATFORM`
- `packages/coding-agent/test/fixtures/crash-after-init-mcp.ts`
  - `OMP_TEST_SPAWN_LOG -> MARS_TEST_SPAWN_LOG` x2
- `packages/coding-agent/test/fixtures/js-process-entry-import.ts`
  - `OMP_PROCESS_ENTRY_ENV_PROBE -> MARS_PROCESS_ENTRY_ENV_PROBE`
- `packages/coding-agent/test/fixtures/security/seeded-repository/src/fake-secret.ts`
  - `OMP_SECURITY_FIXTURE_NOT_A_REAL_SECRET_000000 -> MARS_SECURITY_FIXTURE_NOT_A_REAL_SECRET_000000`
- `packages/coding-agent/test/image-webp-exclusion.test.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP` x6
- `packages/coding-agent/test/internal-urls/issue-pr-protocol.test.ts`
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB` x5
- `packages/coding-agent/test/issue-5879-legacy-event-stream-factory.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/issue-8096-broker-unreachable-startup.test.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x4
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x6
- `packages/coding-agent/test/launch/broker-metadata-writes.test.ts`
  - `OMP_SPEC_TEST_MARKER -> MARS_SPEC_TEST_MARKER` x2
- `packages/coding-agent/test/legacy-pi-extension-cache.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/main-cross-project-resume.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/marketplace/substitute-plugin-root.test.ts`
  - `OMP_PLUGIN_ROOT -> MARS_PLUGIN_ROOT`
  - `OMP_VAR -> MARS_VAR` x3
- `packages/coding-agent/test/mcp-long-wait.test.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x2
- `packages/coding-agent/test/mcp-print-readiness.test.ts`
  - `OMP_MCP_REQUIRE_READY -> MARS_MCP_REQUIRE_READY` x7
  - `OMP_MCP_STARTUP_TIMEOUT_MS -> MARS_MCP_STARTUP_TIMEOUT_MS` x6
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x7
- `packages/coding-agent/test/mcp-reconnect-storm.test.ts`
  - `OMP_TEST_SPAWN_LOG -> MARS_TEST_SPAWN_LOG`
- `packages/coding-agent/test/mcp-startup-no-block.test.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS`
- `packages/coding-agent/test/mcp-timeout.test.ts`
  - `OMP_MCP_TIMEOUT_MS -> MARS_MCP_TIMEOUT_MS` x10
- `packages/coding-agent/test/model-config-live-headers.test.ts`
  - `OMP_TEST_LIVE_DYN -> MARS_TEST_LIVE_DYN` x3
  - `OMP_TEST_LIVE_KEY -> MARS_TEST_LIVE_KEY` x2
- `packages/coding-agent/test/non-interactive-env.test.ts`
  - `OMP_TEST_INHERITED_MARKER -> MARS_TEST_INHERITED_MARKER` x2
- `packages/coding-agent/test/profile-cli.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x8
  - `OMP_PROFILE_BOOTSTRAP_SENTINEL -> MARS_PROFILE_BOOTSTRAP_SENTINEL` x4
- `packages/coding-agent/test/sdk-agent-dir-rules.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/sdk-restricted-extension-provider.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x3
- `packages/coding-agent/test/secrets-obfuscator.test.ts`
  - `OMP_TEST_CONNURL_DSN -> MARS_TEST_CONNURL_DSN`
  - `OMP_TEST_CONNURL_ENCODED -> MARS_TEST_CONNURL_ENCODED`
  - `OMP_TEST_CONNURL_NOUSER -> MARS_TEST_CONNURL_NOUSER`
  - `OMP_TEST_CONNURL_PLAIN -> MARS_TEST_CONNURL_PLAIN`
  - `OMP_TEST_CONNURL_RAW_AT -> MARS_TEST_CONNURL_RAW_AT`
  - `OMP_TEST_CONNURL_SHORT -> MARS_TEST_CONNURL_SHORT`
- `packages/coding-agent/test/session-manager-cwd-adoption.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/session-manager/snapcompact-frame-lazy-resolution.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/session/picker-worktrees.test.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x2
- `packages/coding-agent/test/session/redis-session-storage-manager.test.ts`
  - `OMP_APPEND -> MARS_APPEND`
  - `OMP_UPDATE_TITLE -> MARS_UPDATE_TITLE`
  - `OMP_WRITE_FULL -> MARS_WRITE_FULL`
- `packages/coding-agent/test/session/redis-session-storage.test.ts`
  - `OMP_APPEND -> MARS_APPEND`
  - `OMP_UPDATE_TITLE -> MARS_UPDATE_TITLE`
  - `OMP_WRITE_FULL -> MARS_WRITE_FULL`
- `packages/coding-agent/test/session/session-worktree.test.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x4
- `packages/coding-agent/test/skills.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/system-prompt-model.test.ts`
  - `OMP_EXPECTED_DATE -> MARS_EXPECTED_DATE` x2
  - `OMP_REJECTED_DATE -> MARS_REJECTED_DATE` x2
  - `OMP_TEST_NOW -> MARS_TEST_NOW` x2
- `packages/coding-agent/test/task/discovery.test.ts`
  - `OMP_AGENT_MD -> MARS_AGENT_MD` x2
  - `OMP_PLUGIN_AGENT_MD -> MARS_PLUGIN_AGENT_MD` x2
- `packages/coding-agent/test/task/focused-subagent-manual-yield.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/task/parked-subagent-session-release.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/task/parked-subagent-shell-release.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/task/worktree.test.ts`
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x8
- `packages/coding-agent/test/tiny-worker-env.test.ts`
  - `OMP_NATIVE_LIBRARY_PATH -> MARS_NATIVE_LIBRARY_PATH` x4
  - `OMP_WORKER_ENV_PROBE -> MARS_WORKER_ENV_PROBE` x2
- `packages/coding-agent/test/token-mcp-oauth-refresh.test.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x2
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/coding-agent/test/tools/bash-interactive.test.ts`
  - `OMP_PTY_LAYER -> MARS_PTY_LAYER` x3
  - `OMP_PTY_RUNTIME_PROBE -> MARS_PTY_RUNTIME_PROBE` x2
- `packages/coding-agent/test/tools/browser-launch.test.ts`
  - `OMP_BROWSER_PROBE_PLATFORM -> MARS_BROWSER_PROBE_PLATFORM` x2
- `packages/coding-agent/test/tools/browser-relay-daemon.test.ts`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS` x2
  - `OMP_PROFILE -> MARS_PROFILE`
  - `OMP_TEST_FIRST_RELAY_URL -> MARS_TEST_FIRST_RELAY_URL` x2
  - `OMP_TEST_READY_MARKER -> MARS_TEST_READY_MARKER` x2
  - `OMP_TEST_RELAY_URL -> MARS_TEST_RELAY_URL` x4
  - `OMP_TEST_SECOND_RELAY_URL -> MARS_TEST_SECOND_RELAY_URL` x2
- `packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts`
  - `OMP_TEST_VISIBLE_BROWSER -> MARS_TEST_VISIBLE_BROWSER` x2
- `packages/coding-agent/test/tools/gh-cache-invalidation.test.ts`
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB` x4
- `packages/coding-agent/test/tools/github-cache.test.ts`
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB` x6
- `packages/coding-agent/test/tools/read-pdf-line-range.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/usage-cli-history.test.ts`
  - `OMP_AUTH_BROKER_TOKEN -> MARS_AUTH_BROKER_TOKEN` x2
  - `OMP_AUTH_BROKER_URL -> MARS_AUTH_BROKER_URL` x2
- `packages/coding-agent/test/utils/image-resize.test.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP` x9
- `packages/coding-agent/test/utils/markit-cache.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/coding-agent/test/web/search/cli-provider-settings.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2

#### packages/metaharness

- `packages/metaharness/README.md`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS` x2
- `packages/metaharness/agent/omp_local.py`
  - `OMP_BENCH_ -> MARS_BENCH_`
  - `OMP_BENCH_AGENT_ARGS -> MARS_BENCH_AGENT_ARGS` x3
  - `OMP_BENCH_AUTO_APPROVE -> MARS_BENCH_AUTO_APPROVE`
  - `OMP_BENCH_BINARY_ARM64 -> MARS_BENCH_BINARY_ARM64`
  - `OMP_BENCH_BINARY_X64 -> MARS_BENCH_BINARY_X64`
  - `OMP_BENCH_BUN_VERSION -> MARS_BENCH_BUN_VERSION`
  - `OMP_BENCH_CONTAINER_DNS -> MARS_BENCH_CONTAINER_DNS` x2
  - `OMP_BENCH_FORWARD_ENV -> MARS_BENCH_FORWARD_ENV` x3
  - `OMP_BENCH_GATEWAY -> MARS_BENCH_GATEWAY`
  - `OMP_BENCH_GATEWAY_PROVIDERS -> MARS_BENCH_GATEWAY_PROVIDERS`
  - `OMP_BENCH_GATEWAY_TOKEN -> MARS_BENCH_GATEWAY_TOKEN`
  - `OMP_BENCH_GATEWAY_URL -> MARS_BENCH_GATEWAY_URL`
  - `OMP_BENCH_INSTALL -> MARS_BENCH_INSTALL` x3
  - `OMP_BENCH_MODELS_YAML -> MARS_BENCH_MODELS_YAML`
  - `OMP_BENCH_SETTINGS -> MARS_BENCH_SETTINGS`
  - `OMP_BENCH_SOURCE_ARCH -> MARS_BENCH_SOURCE_ARCH`
  - `OMP_BENCH_SOURCE_BUN -> MARS_BENCH_SOURCE_BUN`
  - `OMP_BENCH_SOURCE_DIR -> MARS_BENCH_SOURCE_DIR`
  - `OMP_BENCH_TARBALL -> MARS_BENCH_TARBALL` x2
  - `OMP_BENCH_THINKING -> MARS_BENCH_THINKING`
  - `OMP_BENCH_TOOLS -> MARS_BENCH_TOOLS`
  - `OMP_BENCH_VERSION -> MARS_BENCH_VERSION`
  - `OMP_BENCH_WEB_SEARCH -> MARS_BENCH_WEB_SEARCH`
  - `OMP_CONFIG_EOF -> MARS_CONFIG_EOF`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS` x2
  - `OMP_MODELS_EOF -> MARS_MODELS_EOF`
- `packages/metaharness/agent/pi_upstream.py`
  - `OMP_BENCH_ -> MARS_BENCH_`
  - `OMP_BENCH_AGENT_ARGS -> MARS_BENCH_AGENT_ARGS` x2
  - `OMP_BENCH_FORWARD_ENV -> MARS_BENCH_FORWARD_ENV` x2
  - `OMP_BENCH_GATEWAY_TOKEN -> MARS_BENCH_GATEWAY_TOKEN` x2
  - `OMP_BENCH_GATEWAY_URL -> MARS_BENCH_GATEWAY_URL` x2
  - `OMP_BENCH_NODE_VERSION -> MARS_BENCH_NODE_VERSION` x2
  - `OMP_BENCH_PI_MODELS -> MARS_BENCH_PI_MODELS` x2
  - `OMP_BENCH_PI_SYSTEM_PROMPT -> MARS_BENCH_PI_SYSTEM_PROMPT` x3
  - `OMP_BENCH_PI_VERSION -> MARS_BENCH_PI_VERSION` x2
  - `OMP_BENCH_THINKING -> MARS_BENCH_THINKING` x2
  - `OMP_BENCH_TOOLS -> MARS_BENCH_TOOLS` x2
- `packages/metaharness/src/runner.ts`
  - `OMP_BENCH_ -> MARS_BENCH_` x3
  - `OMP_BENCH_AGENT_ARGS -> MARS_BENCH_AGENT_ARGS`
  - `OMP_BENCH_BINARY_ARM64 -> MARS_BENCH_BINARY_ARM64`
  - `OMP_BENCH_BINARY_X64 -> MARS_BENCH_BINARY_X64`
  - `OMP_BENCH_CONTAINER_DNS -> MARS_BENCH_CONTAINER_DNS` x3
  - `OMP_BENCH_FORWARD_ENV -> MARS_BENCH_FORWARD_ENV` x7
  - `OMP_BENCH_GATEWAY -> MARS_BENCH_GATEWAY`
  - `OMP_BENCH_GATEWAY_PROVIDERS -> MARS_BENCH_GATEWAY_PROVIDERS`
  - `OMP_BENCH_GATEWAY_TOKEN -> MARS_BENCH_GATEWAY_TOKEN`
  - `OMP_BENCH_GATEWAY_URL -> MARS_BENCH_GATEWAY_URL`
  - `OMP_BENCH_INSTALL -> MARS_BENCH_INSTALL`
  - `OMP_BENCH_MODELS_YAML -> MARS_BENCH_MODELS_YAML`
  - `OMP_BENCH_PI_MODELS -> MARS_BENCH_PI_MODELS`
  - `OMP_BENCH_PI_SYSTEM_PROMPT -> MARS_BENCH_PI_SYSTEM_PROMPT`
  - `OMP_BENCH_PI_VERSION -> MARS_BENCH_PI_VERSION`
  - `OMP_BENCH_SETTINGS -> MARS_BENCH_SETTINGS`
  - `OMP_BENCH_SOURCE_ARCH -> MARS_BENCH_SOURCE_ARCH`
  - `OMP_BENCH_SOURCE_BUN -> MARS_BENCH_SOURCE_BUN`
  - `OMP_BENCH_SOURCE_DIR -> MARS_BENCH_SOURCE_DIR`
  - `OMP_BENCH_TARBALL -> MARS_BENCH_TARBALL`
  - `OMP_BENCH_THINKING -> MARS_BENCH_THINKING`
  - `OMP_BENCH_TOOLS -> MARS_BENCH_TOOLS`
  - `OMP_BENCH_VERSION -> MARS_BENCH_VERSION`
  - `OMP_BENCH_WEB_SEARCH -> MARS_BENCH_WEB_SEARCH`
- `packages/metaharness/src/tb/agent.ts`
  - `OMP_CONFIG_EOF -> MARS_CONFIG_EOF` x2
  - `OMP_MODELS_EOF -> MARS_MODELS_EOF` x2
- `packages/metaharness/src/tb/trial.ts`
  - `OMP_DAEMON_IDLE_GRACE_MS -> MARS_DAEMON_IDLE_GRACE_MS` x2
- `packages/metaharness/test/runner.test.ts`
  - `OMP_BENCH_AGENT_ARGS -> MARS_BENCH_AGENT_ARGS` x3
  - `OMP_BENCH_GATEWAY_PROVIDERS -> MARS_BENCH_GATEWAY_PROVIDERS` x2
  - `OMP_BENCH_INSTALL -> MARS_BENCH_INSTALL` x2
  - `OMP_BENCH_SOURCE_ARCH -> MARS_BENCH_SOURCE_ARCH` x2
  - `OMP_BENCH_SOURCE_BUN -> MARS_BENCH_SOURCE_BUN`
  - `OMP_BENCH_SOURCE_DIR -> MARS_BENCH_SOURCE_DIR` x2

#### packages/natives

- `packages/natives/native/index.d.ts`
  - `OMP_MINIMIZER_LEGACY_FILTERS -> MARS_MINIMIZER_LEGACY_FILTERS`
- `packages/natives/scripts/build-bindings.ts`
  - `OMP_NATIVE_CARGO_PROFILE -> MARS_NATIVE_CARGO_PROFILE` x2
  - `OMP_NATIVE_FEATURES -> MARS_NATIVE_FEATURES` x3

#### packages/stats

- `packages/stats/test/server-embedded-client.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`

#### packages/tui

- `packages/tui/src/chat/image-loading.ts`
  - `OMP_NO_WEBP -> MARS_NO_WEBP` x2
- `packages/tui/src/debug-server.ts`
  - `OMP_TUI_DEBUG -> MARS_TUI_DEBUG`
- `packages/tui/src/setup/wizard.ts`
  - `OMP_SKIP_SETUP -> MARS_SKIP_SETUP`
- `packages/tui/src/tui.ts`
  - `OMP_TUI_DEBUG -> MARS_TUI_DEBUG`
- `packages/tui/test/composer-cache.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/tui/test/debug-server.test.ts`
  - `OMP_TUI_DEBUG -> MARS_TUI_DEBUG` x5
- `packages/tui/test/keybindings-migration.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x3
- `packages/tui/test/native/blobs.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE`

#### packages/utils

- `packages/utils/src/dirs.ts`
  - `OMP_APP_NAME -> MARS_APP_NAME` x2
  - `OMP_AUTH_BROKER_SNAPSHOT_CACHE -> MARS_AUTH_BROKER_SNAPSHOT_CACHE` x2
  - `OMP_COMMIT_CACHE_DB -> MARS_COMMIT_CACHE_DB` x2
  - `OMP_GITHUB_CACHE_DB -> MARS_GITHUB_CACHE_DB` x2
  - `OMP_JUDGMENT_CACHE_DB -> MARS_JUDGMENT_CACHE_DB` x2
  - `OMP_PROFILE -> MARS_PROFILE` x8
  - `OMP_WORKTREE_DIR -> MARS_WORKTREE_DIR` x3
- `packages/utils/src/env.ts`
  - `OMP_ -> MARS_` x3
- `packages/utils/src/logger.ts`
  - `OMP_LOG_LEVEL -> MARS_LOG_LEVEL` x4
- `packages/utils/src/ptree.ts`
  - `OMP_PTREE_SUBREAPER_BUN_BE_BUN -> MARS_PTREE_SUBREAPER_BUN_BE_BUN`
  - `OMP_PTREE_SUBREAPER_COMMAND -> MARS_PTREE_SUBREAPER_COMMAND`
- `packages/utils/test/browsers.test.ts`
  - `OMP_TEST_BROWSER_INSTALL -> MARS_TEST_BROWSER_INSTALL`
- `packages/utils/test/dirs-xdg.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/utils/test/env.test.ts`
  - `OMP_ -> MARS_`
  - `OMP_DOTENV_REPRO_MARKER -> MARS_DOTENV_REPRO_MARKER` x7
  - `OMP_FEATURE -> MARS_FEATURE` x2
- `packages/utils/test/fixtures/logger-contract-probe.ts`
  - `OMP_LOGGER_TEST_NOW -> MARS_LOGGER_TEST_NOW` x2
- `packages/utils/test/fixtures/logger-fixed-date-preload.ts`
  - `OMP_LOGGER_TEST_NOW -> MARS_LOGGER_TEST_NOW` x3
- `packages/utils/test/fixtures/stderr-guard-rotation-probe.ts`
  - `OMP_LOGGER_TEST_NOW -> MARS_LOGGER_TEST_NOW` x3
- `packages/utils/test/logger-contract.test.ts`
  - `OMP_LOGGER_TEST_NOW -> MARS_LOGGER_TEST_NOW`
  - `OMP_LOG_LEVEL -> MARS_LOG_LEVEL` x2
  - `OMP_PROFILE -> MARS_PROFILE`
- `packages/utils/test/logger-no-transports.test.ts`
  - `OMP_AGENT_DIR -> MARS_AGENT_DIR` x4
- `packages/utils/test/natives-dir-override.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x2
- `packages/utils/test/postmortem-cleanup-error.test.ts`
  - `OMP_AGENT_DIR -> MARS_AGENT_DIR`
- `packages/utils/test/procmgr.test.ts`
  - `OMP_REFRESH_DOTENV_ONLY -> MARS_REFRESH_DOTENV_ONLY` x3
  - `OMP_REFRESH_LAUNCH_SECRET -> MARS_REFRESH_LAUNCH_SECRET` x4
  - `OMP_REFRESH_SHARED -> MARS_REFRESH_SHARED` x3
- `packages/utils/test/profiles.test.ts`
  - `OMP_PROFILE -> MARS_PROFILE` x12
  - `OMP_WORKER_HOST_PROBE -> MARS_WORKER_HOST_PROBE` x3
- `packages/utils/test/ptree-timeout.test.ts`
  - `OMP_PTREE_SUBREAPER_COMMAND -> MARS_PTREE_SUBREAPER_COMMAND` x2
- `packages/utils/test/stderr-guard.test.ts`
  - `OMP_LOGGER_TEST_NOW -> MARS_LOGGER_TEST_NOW`

#### python/robomp

- `python/robomp/src/worker.py`
  - `OMP_APP_NAME -> MARS_APP_NAME`

#### scripts/bazel-natives.ts

- `scripts/bazel-natives.ts`
  - `OMP_BAZEL_RC -> MARS_BAZEL_RC`
  - `OMP_NATIVE_BUILD_BACKEND -> MARS_NATIVE_BUILD_BACKEND` x5

#### scripts/ci-macos-upload-secrets.sh

- `scripts/ci-macos-upload-secrets.sh`
  - `OMP_REPO -> MARS_REPO` x2
  - `OMP_SIGNING_DIR -> MARS_SIGNING_DIR`

#### scripts/ci-release-notes.ts

- `scripts/ci-release-notes.ts`
  - `OMP_RELEASE_NOTES_FLOOR -> MARS_RELEASE_NOTES_FLOOR` x5
  - `OMP_REPO -> MARS_REPO` x2

#### scripts/ci-test-ts.test.ts

- `scripts/ci-test-ts.test.ts`
  - `OMP_TEST_CHUNK_TIMEOUT -> MARS_TEST_CHUNK_TIMEOUT`
  - `OMP_TEST_SHARD -> MARS_TEST_SHARD` x2

#### scripts/ci-test-ts.ts

- `scripts/ci-test-ts.ts`
  - `OMP_TEST_CHUNK_TIMEOUT -> MARS_TEST_CHUNK_TIMEOUT` x5
  - `OMP_TEST_CONCURRENCY -> MARS_TEST_CONCURRENCY` x5
  - `OMP_TEST_SHARD -> MARS_TEST_SHARD` x4
  - `OMP_TEST_TIMEOUT -> MARS_TEST_TIMEOUT` x2

#### scripts/ci-update-brew-formula.ts

- `scripts/ci-update-brew-formula.ts`
  - `OMP_REPO -> MARS_REPO`

#### scripts/edit_benchmark_common.py

- `scripts/edit_benchmark_common.py`
  - `OMP_BIN -> MARS_BIN` x2

#### scripts/env-codemod.py

- `scripts/env-codemod.py`
  - `OMP_ -> MARS_` x2

#### scripts/fix-changelogs.test.ts

- `scripts/fix-changelogs.test.ts`
  - `OMP_REPO -> MARS_REPO`

#### scripts/fix-changelogs.ts

- `scripts/fix-changelogs.ts`
  - `OMP_REPO -> MARS_REPO`

#### scripts/install-tests

- `scripts/install-tests/run-ci.sh`
  - `OMP_INSTALL_TEST_SKIP_NATIVE_BUILD -> MARS_INSTALL_TEST_SKIP_NATIVE_BUILD`

#### scripts/rate-edit-tool.py

- `scripts/rate-edit-tool.py`
  - `OMP_BIN -> MARS_BIN` x2

#### scripts/rebrand-codemod.py

- `scripts/rebrand-codemod.py`
  - `OMP_ -> MARS_`

#### scripts/setup.ts

- `scripts/setup.ts`
  - `OMP_NATIVE_BUILD_BACKEND -> MARS_NATIVE_BUILD_BACKEND`

#### sdk/go

- `sdk/go/omp-rpc/README.md`
  - `OMP_RPC_SMOKE -> MARS_RPC_SMOKE`
- `sdk/go/omp-rpc/smoke_test.go`
  - `OMP_RPC_SMOKE -> MARS_RPC_SMOKE` x3
