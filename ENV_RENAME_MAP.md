# ENV rename map: OMP_* -> MARS_*

Generated 2026-10-09 from `git grep -n -w "OMP_[A-Z0-9_]*"`
on branch `rebrand/mars`. Rule: word-boundary match only (`\bOMP_[A-Z0-9_]*\b`),
so longer tokens like `COMP_FOO` never match. `PI_*` is untouched. No `OMP_*`
fallback aliases (Mars has no existing users). Exception: `MARS_PROFILE` is the
primary profile selector with `PI_PROFILE` kept as the legacy fallback, following
the existing `OMP_PROFILE`/`PI_PROFILE` alias pattern in `resolveProfileEnv`
(`packages/utils/src/dirs.ts`).

## Totals

- Distinct variable names: **172**
- Total occurrences (including prose references): **963**
- Tracked files containing at least one match: **231**

## Every variable

| Occurrences | Old name | New name |
| --- | --- | --- |
| 105 | `OMP_PROFILE` | `MARS_PROFILE` |
| 64 | `OMP_AUTH_BROKER_URL` | `MARS_AUTH_BROKER_URL` |
| 49 | `OMP_AUTH_BROKER_TOKEN` | `MARS_AUTH_BROKER_TOKEN` |
| 39 | `OMP_MCP_TIMEOUT_MS` | `MARS_MCP_TIMEOUT_MS` |
| 37 | `OMP_WORKTREE_DIR` | `MARS_WORKTREE_DIR` |
| 26 | `OMP_NO_WEBP` | `MARS_NO_WEBP` |
| 20 | `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | `MARS_AUTH_BROKER_ACCOUNT_POOL_FILE` |
| 19 | `OMP_GITHUB_CACHE_DB` | `MARS_GITHUB_CACHE_DB` |
| 18 | `OMP_` | `MARS_` (bare prefix, prose only — same word-boundary rule rewrites it) |
| 16 | `OMP_AUTORESEARCH_DB_DIR` | `MARS_AUTORESEARCH_DB_DIR` |
| 14 | `OMP_TUI_DEBUG` | `MARS_TUI_DEBUG` |
| 12 | `OMP_BENCH_FORWARD_ENV` | `MARS_BENCH_FORWARD_ENV` |
| 12 | `OMP_MCP_REQUIRE_READY` | `MARS_MCP_REQUIRE_READY` |
| 12 | `OMP_NATIVE_BUILD_BACKEND` | `MARS_NATIVE_BUILD_BACKEND` |
| 11 | `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | `MARS_AUTH_BROKER_SNAPSHOT_TTL_MS` |
| 11 | `OMP_MCP_STARTUP_TIMEOUT_MS` | `MARS_MCP_STARTUP_TIMEOUT_MS` |
| 10 | `OMP_DAEMON_IDLE_GRACE_MS` | `MARS_DAEMON_IDLE_GRACE_MS` |
| 10 | `OMP_LOGGER_TEST_NOW` | `MARS_LOGGER_TEST_NOW` |
| 10 | `OMP_NATIVE_LIBRARY_PATH` | `MARS_NATIVE_LIBRARY_PATH` |
| 10 | `OMP_NUM_THREADS` | `MARS_NUM_THREADS` |
| 10 | `OMP_TEST_CONCURRENCY` | `MARS_TEST_CONCURRENCY` |
| 9 | `OMP_AGENT_DIR` | `MARS_AGENT_DIR` |
| 9 | `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | `MARS_AUTH_BROKER_SNAPSHOT_CACHE` |
| 9 | `OMP_BENCH_AGENT_ARGS` | `MARS_BENCH_AGENT_ARGS` |
| 9 | `OMP_LOG_LEVEL` | `MARS_LOG_LEVEL` |
| 9 | `OMP_PLUGIN_ROOT` | `MARS_PLUGIN_ROOT` |
| 9 | `OMP_REPO` | `MARS_REPO` |
| 8 | `OMP_LAUNCH_CWD` | `MARS_LAUNCH_CWD` |
| 7 | `OMP_DOTENV_REPRO_MARKER` | `MARS_DOTENV_REPRO_MARKER` |
| 7 | `OMP_TEST_SHARD` | `MARS_TEST_SHARD` |
| 6 | `OMP_BENCH_` | `MARS_BENCH_` |
| 6 | `OMP_BENCH_INSTALL` | `MARS_BENCH_INSTALL` |
| 6 | `OMP_MINIMIZER_LEGACY_FILTERS` | `MARS_MINIMIZER_LEGACY_FILTERS` |
| 6 | `OMP_NATIVE_FEATURES` | `MARS_NATIVE_FEATURES` |
| 6 | `OMP_PCRE2_JIT` | `MARS_PCRE2_JIT` |
| 6 | `OMP_TEST_CHUNK_TIMEOUT` | `MARS_TEST_CHUNK_TIMEOUT` |
| 6 | `OMP_USER_SHELL_MIRROR` | `MARS_USER_SHELL_MIRROR` |
| 6 | `OMP_XWIN_CACHE_DIR` | `MARS_XWIN_CACHE_DIR` |
| 5 | `OMP_BENCH_CONTAINER_DNS` | `MARS_BENCH_CONTAINER_DNS` |
| 5 | `OMP_E2E_GATEWAY_URL` | `MARS_E2E_GATEWAY_URL` |
| 5 | `OMP_NATIVE_CARGO_PROFILE` | `MARS_NATIVE_CARGO_PROFILE` |
| 5 | `OMP_RELEASE_NOTES_FLOOR` | `MARS_RELEASE_NOTES_FLOOR` |
| 5 | `OMP_VAR` | `MARS_VAR` |
| 4 | `OMP_APPLEFM_BRIDGE` | `MARS_APPLEFM_BRIDGE` |
| 4 | `OMP_APPLEFM_SWIFTC` | `MARS_APPLEFM_SWIFTC` |
| 4 | `OMP_APP_NAME` | `MARS_APP_NAME` |
| 4 | `OMP_BENCH_GATEWAY_PROVIDERS` | `MARS_BENCH_GATEWAY_PROVIDERS` |
| 4 | `OMP_BENCH_GATEWAY_TOKEN` | `MARS_BENCH_GATEWAY_TOKEN` |
| 4 | `OMP_BENCH_GATEWAY_URL` | `MARS_BENCH_GATEWAY_URL` |
| 4 | `OMP_BENCH_PI_SYSTEM_PROMPT` | `MARS_BENCH_PI_SYSTEM_PROMPT` |
| 4 | `OMP_BENCH_SOURCE_ARCH` | `MARS_BENCH_SOURCE_ARCH` |
| 4 | `OMP_BENCH_SOURCE_DIR` | `MARS_BENCH_SOURCE_DIR` |
| 4 | `OMP_BENCH_THINKING` | `MARS_BENCH_THINKING` |
| 4 | `OMP_BENCH_TOOLS` | `MARS_BENCH_TOOLS` |
| 4 | `OMP_BIN` | `MARS_BIN` |
| 4 | `OMP_INJECTED_TOKEN` | `MARS_INJECTED_TOKEN` |
| 4 | `OMP_MARKETPLACE_DIR` | `MARS_MARKETPLACE_DIR` |
| 4 | `OMP_PLUGIN_DIR` | `MARS_PLUGIN_DIR` |
| 4 | `OMP_PROFILE_BOOTSTRAP_SENTINEL` | `MARS_PROFILE_BOOTSTRAP_SENTINEL` |
| 4 | `OMP_REFRESH_LAUNCH_SECRET` | `MARS_REFRESH_LAUNCH_SECRET` |
| 4 | `OMP_RPC_SMOKE` | `MARS_RPC_SMOKE` |
| 4 | `OMP_SYNTAX_SET` | `MARS_SYNTAX_SET` |
| 4 | `OMP_TEST_RELAY_URL` | `MARS_TEST_RELAY_URL` |
| 3 | `OMP_APPEND` | `MARS_APPEND` |
| 3 | `OMP_APPLEFM_MODULE_CACHE` | `MARS_APPLEFM_MODULE_CACHE` |
| 3 | `OMP_AUTH_BROKER_` | `MARS_AUTH_BROKER_` |
| 3 | `OMP_BAZEL_RC` | `MARS_BAZEL_RC` |
| 3 | `OMP_BENCH_PI_MODELS` | `MARS_BENCH_PI_MODELS` |
| 3 | `OMP_BENCH_PI_VERSION` | `MARS_BENCH_PI_VERSION` |
| 3 | `OMP_BENCH_SOURCE_BUN` | `MARS_BENCH_SOURCE_BUN` |
| 3 | `OMP_BENCH_TARBALL` | `MARS_BENCH_TARBALL` |
| 3 | `OMP_BROWSER_PROBE_PLATFORM` | `MARS_BROWSER_PROBE_PLATFORM` |
| 3 | `OMP_CAPTURE_DARWIN_HELPER` | `MARS_CAPTURE_DARWIN_HELPER` |
| 3 | `OMP_CONFIG_EOF` | `MARS_CONFIG_EOF` |
| 3 | `OMP_MODELS_EOF` | `MARS_MODELS_EOF` |
| 3 | `OMP_OAUTH_DARWIN_HELPER` | `MARS_OAUTH_DARWIN_HELPER` |
| 3 | `OMP_OAUTH_RELAY_BINARY` | `MARS_OAUTH_RELAY_BINARY` |
| 3 | `OMP_PROCESS_ENTRY_ENV_PROBE` | `MARS_PROCESS_ENTRY_ENV_PROBE` |
| 3 | `OMP_PTREE_SUBREAPER_COMMAND` | `MARS_PTREE_SUBREAPER_COMMAND` |
| 3 | `OMP_PTY_LAYER` | `MARS_PTY_LAYER` |
| 3 | `OMP_REFRESH_DOTENV_ONLY` | `MARS_REFRESH_DOTENV_ONLY` |
| 3 | `OMP_REFRESH_SHARED` | `MARS_REFRESH_SHARED` |
| 3 | `OMP_SECURITY_WORKFLOW_VERSION` | `MARS_SECURITY_WORKFLOW_VERSION` |
| 3 | `OMP_SMOKE_INSTANCE_ID` | `MARS_SMOKE_INSTANCE_ID` |
| 3 | `OMP_SMOKE_MARKER` | `MARS_SMOKE_MARKER` |
| 3 | `OMP_TEST_BAD_VALUE_8925` | `MARS_TEST_BAD_VALUE_8925` |
| 3 | `OMP_TEST_KEEP_8925` | `MARS_TEST_KEEP_8925` |
| 3 | `OMP_TEST_LIVE_DYN` | `MARS_TEST_LIVE_DYN` |
| 3 | `OMP_TEST_MCP_KEY` | `MARS_TEST_MCP_KEY` |
| 3 | `OMP_TEST_MCP_PATH` | `MARS_TEST_MCP_PATH` |
| 3 | `OMP_TEST_SPAWN_LOG` | `MARS_TEST_SPAWN_LOG` |
| 3 | `OMP_TEST_TIMEOUT` | `MARS_TEST_TIMEOUT` |
| 3 | `OMP_THREAD_LIMIT` | `MARS_THREAD_LIMIT` |
| 3 | `OMP_TITLE_PROBE_PATH` | `MARS_TITLE_PROBE_PATH` |
| 3 | `OMP_UPDATE_TITLE` | `MARS_UPDATE_TITLE` |
| 3 | `OMP_USER_SHELL_ENV` | `MARS_USER_SHELL_ENV` |
| 3 | `OMP_WORKER_HOST_PROBE` | `MARS_WORKER_HOST_PROBE` |
| 3 | `OMP_WRITE_FULL` | `MARS_WRITE_FULL` |
| 2 | `OMP_AGENT_MD` | `MARS_AGENT_MD` |
| 2 | `OMP_BENCH_BINARY_ARM64` | `MARS_BENCH_BINARY_ARM64` |
| 2 | `OMP_BENCH_BINARY_X64` | `MARS_BENCH_BINARY_X64` |
| 2 | `OMP_BENCH_GATEWAY` | `MARS_BENCH_GATEWAY` |
| 2 | `OMP_BENCH_MODELS_YAML` | `MARS_BENCH_MODELS_YAML` |
| 2 | `OMP_BENCH_NODE_VERSION` | `MARS_BENCH_NODE_VERSION` |
| 2 | `OMP_BENCH_SETTINGS` | `MARS_BENCH_SETTINGS` |
| 2 | `OMP_BENCH_VERSION` | `MARS_BENCH_VERSION` |
| 2 | `OMP_BENCH_WEB_SEARCH` | `MARS_BENCH_WEB_SEARCH` |
| 2 | `OMP_COMMIT_CACHE_DB` | `MARS_COMMIT_CACHE_DB` |
| 2 | `OMP_DECLARE_RO` | `MARS_DECLARE_RO` |
| 2 | `OMP_DEV_LAUNCH_DIR` | `MARS_DEV_LAUNCH_DIR` |
| 2 | `OMP_E2E_ANTHROPIC_MODEL` | `MARS_E2E_ANTHROPIC_MODEL` |
| 2 | `OMP_EXPECTED_DATE` | `MARS_EXPECTED_DATE` |
| 2 | `OMP_FEATURE` | `MARS_FEATURE` |
| 2 | `OMP_GIT_ENV_PROBE` | `MARS_GIT_ENV_PROBE` |
| 2 | `OMP_HARMONY_DEBUG` | `MARS_HARMONY_DEBUG` |
| 2 | `OMP_INSTALL_TEST_SKIP_NATIVE_BUILD` | `MARS_INSTALL_TEST_SKIP_NATIVE_BUILD` |
| 2 | `OMP_JUDGMENT_CACHE_DB` | `MARS_JUDGMENT_CACHE_DB` |
| 2 | `OMP_NOTIFICATIONS` | `MARS_NOTIFICATIONS` |
| 2 | `OMP_PLUGIN_AGENT_MD` | `MARS_PLUGIN_AGENT_MD` |
| 2 | `OMP_PTY_RUNTIME_PROBE` | `MARS_PTY_RUNTIME_PROBE` |
| 2 | `OMP_REJECTED_DATE` | `MARS_REJECTED_DATE` |
| 2 | `OMP_SIGNING_DIR` | `MARS_SIGNING_DIR` |
| 2 | `OMP_SKIP_SETUP` | `MARS_SKIP_SETUP` |
| 2 | `OMP_SPEC_TEST_MARKER` | `MARS_SPEC_TEST_MARKER` |
| 2 | `OMP_STATUS_LINE_RE` | `MARS_STATUS_LINE_RE` |
| 2 | `OMP_TEST_CORRUPT_8925` | `MARS_TEST_CORRUPT_8925` |
| 2 | `OMP_TEST_FIRST_RELAY_URL` | `MARS_TEST_FIRST_RELAY_URL` |
| 2 | `OMP_TEST_INHERITED_MARKER` | `MARS_TEST_INHERITED_MARKER` |
| 2 | `OMP_TEST_LIVE_KEY` | `MARS_TEST_LIVE_KEY` |
| 2 | `OMP_TEST_MCP_ABSENT` | `MARS_TEST_MCP_ABSENT` |
| 2 | `OMP_TEST_NOW` | `MARS_TEST_NOW` |
| 2 | `OMP_TEST_READY_MARKER` | `MARS_TEST_READY_MARKER` |
| 2 | `OMP_TEST_SECOND_RELAY_URL` | `MARS_TEST_SECOND_RELAY_URL` |
| 2 | `OMP_TEST_SENTINEL_8925` | `MARS_TEST_SENTINEL_8925` |
| 2 | `OMP_TEST_VISIBLE_BROWSER` | `MARS_TEST_VISIBLE_BROWSER` |
| 2 | `OMP_TINY_WORKER_IDLE_MS` | `MARS_TINY_WORKER_IDLE_MS` |
| 2 | `OMP_TINY_WORKER_SOCKET` | `MARS_TINY_WORKER_SOCKET` |
| 2 | `OMP_WORKER_ENV_PROBE` | `MARS_WORKER_ENV_PROBE` |
| 1 | `OMP_BENCH_AUTO_APPROVE` | `MARS_BENCH_AUTO_APPROVE` |
| 1 | `OMP_BENCH_BUN_VERSION` | `MARS_BENCH_BUN_VERSION` |
| 1 | `OMP_BLOB_BROKER_CONFIG` | `MARS_BLOB_BROKER_CONFIG` |
| 1 | `OMP_BLOB_BROKER_SOCKET` | `MARS_BLOB_BROKER_SOCKET` |
| 1 | `OMP_DAEMON_PROJECT_DIR` | `MARS_DAEMON_PROJECT_DIR` |
| 1 | `OMP_DAEMON_RUNTIME_DIR` | `MARS_DAEMON_RUNTIME_DIR` |
| 1 | `OMP_DEV` | `MARS_DEV` |
| 1 | `OMP_DIRENV_TEST_` | `MARS_DIRENV_TEST_` |
| 1 | `OMP_E2E_CODEX_MODEL` | `MARS_E2E_CODEX_MODEL` |
| 1 | `OMP_E2E_OPENAI_RESPONSES_MODEL` | `MARS_E2E_OPENAI_RESPONSES_MODEL` |
| 1 | `OMP_EVAL_HOST_EXECUTION_` | `MARS_EVAL_HOST_EXECUTION_` |
| 1 | `OMP_HARDWARE_CURSOR` | `MARS_HARDWARE_CURSOR` |
| 1 | `OMP_IDA_HOST_CONFIG` | `MARS_IDA_HOST_CONFIG` |
| 1 | `OMP_LSP_MUX_PROJECT_DIR` | `MARS_LSP_MUX_PROJECT_DIR` |
| 1 | `OMP_LSP_MUX_SOCKET` | `MARS_LSP_MUX_SOCKET` |
| 1 | `OMP_NATIVE_AUDIO_CAPTURE_TEST` | `MARS_NATIVE_AUDIO_CAPTURE_TEST` |
| 1 | `OMP_NATIVE_AUDIO_PLAYBACK_TEST` | `MARS_NATIVE_AUDIO_PLAYBACK_TEST` |
| 1 | `OMP_NATIVE_CACHE_DIR` | `MARS_NATIVE_CACHE_DIR` |
| 1 | `OMP_PTREE_SUBREAPER_BUN_BE_BUN` | `MARS_PTREE_SUBREAPER_BUN_BE_BUN` |
| 1 | `OMP_SECURITY_FIXTURE_NOT_A_REAL_SECRET_000000` | `MARS_SECURITY_FIXTURE_NOT_A_REAL_SECRET_000000` |
| 1 | `OMP_TEST_BAD_KEY` | `MARS_TEST_BAD_KEY` |
| 1 | `OMP_TEST_BROWSER_INSTALL` | `MARS_TEST_BROWSER_INSTALL` |
| 1 | `OMP_TEST_CONNURL_DSN` | `MARS_TEST_CONNURL_DSN` |
| 1 | `OMP_TEST_CONNURL_ENCODED` | `MARS_TEST_CONNURL_ENCODED` |
| 1 | `OMP_TEST_CONNURL_NOUSER` | `MARS_TEST_CONNURL_NOUSER` |
| 1 | `OMP_TEST_CONNURL_PLAIN` | `MARS_TEST_CONNURL_PLAIN` |
| 1 | `OMP_TEST_CONNURL_RAW_AT` | `MARS_TEST_CONNURL_RAW_AT` |
| 1 | `OMP_TEST_CONNURL_SHORT` | `MARS_TEST_CONNURL_SHORT` |
| 1 | `OMP_TEXT_PREDICT_AGENT_DIR` | `MARS_TEXT_PREDICT_AGENT_DIR` |
| 1 | `OMP_TEXT_PREDICT_SOCKET` | `MARS_TEXT_PREDICT_SOCKET` |
| 1 | `OMP_TINY_WORKER_MODEL` | `MARS_TINY_WORKER_MODEL` |
| 1 | `OMP_TINY_WORKER_TAG` | `MARS_TINY_WORKER_TAG` |
| 1 | `OMP_TUI_NATIVE` | `MARS_TUI_NATIVE` |
| 1 | `OMP_TUI_WRITE_LOG` | `MARS_TUI_WRITE_LOG` |

## Every file

| Occurrences | File |
| --- | --- |
| 34 | `packages/metaharness/agent/omp_local.py` |
| 34 | `packages/metaharness/src/runner.ts` |
| 21 | `packages/utils/src/dirs.ts` |
| 20 | `packages/coding-agent/test/mcp-print-readiness.test.ts` |
| 19 | `docs/environment-variables.md` |
| 16 | `packages/coding-agent/test/auth-broker-snapshot-cache.test.ts` |
| 16 | `packages/metaharness/agent/pi_upstream.py` |
| 16 | `scripts/ci-test-ts.ts` |
| 15 | `docs/auth-broker-gateway.md` |
| 15 | `packages/ai/src/auth-broker/discover.ts` |
| 15 | `packages/utils/test/profiles.test.ts` |
| 13 | `packages/coding-agent/test/agent-session-bash-session-ownership.test.ts` |
| 13 | `packages/coding-agent/test/auth-broker-import.test.ts` |
| 12 | `crates/pi-builtins/src/nproc.rs` |
| 12 | `packages/coding-agent/test/acp-builtins.test.ts` |
| 12 | `packages/coding-agent/test/profile-cli.test.ts` |
| 12 | `packages/coding-agent/test/tools/browser-relay-daemon.test.ts` |
| 12 | `packages/metaharness/test/runner.test.ts` |
| 10 | `packages/coding-agent/test/issue-8096-broker-unreachable-startup.test.ts` |
| 10 | `packages/coding-agent/test/mcp-timeout.test.ts` |
| 10 | `packages/utils/test/env.test.ts` |
| 9 | `packages/ai/test/auth-broker-config-discovery.test.ts` |
| 9 | `packages/coding-agent/test/utils/image-resize.test.ts` |
| 9 | `packages/utils/test/procmgr.test.ts` |
| 8 | `.github/workflows/ci.yml` |
| 8 | `packages/coding-agent/test/autoresearch-tools.test.ts` |
| 8 | `packages/coding-agent/test/debug/dap-config.test.ts` |
| 8 | `packages/coding-agent/test/discovery/opencode.test.ts` |
| 8 | `packages/coding-agent/test/task/worktree.test.ts` |
| 7 | `REBRAND_AUDIT.md` |
| 7 | `crates/pi-natives/build.rs` |
| 7 | `crates/vendor/brush-core/src/sys/unix/env.rs` |
| 7 | `docs/settings.md` |
| 7 | `scripts/ci-release-notes.ts` |
| 6 | `crates/pi-natives/BUILD.bazel` |
| 6 | `packages/ai/test/auth-broker-remote-store.test.ts` |
| 6 | `packages/coding-agent/src/cli.ts` |
| 6 | `packages/coding-agent/test/auth-gateway-account-pool.test.ts` |
| 6 | `packages/coding-agent/test/image-webp-exclusion.test.ts` |
| 6 | `packages/coding-agent/test/secrets-obfuscator.test.ts` |
| 6 | `packages/coding-agent/test/system-prompt-model.test.ts` |
| 6 | `packages/coding-agent/test/tiny-worker-env.test.ts` |
| 6 | `packages/coding-agent/test/tools/github-cache.test.ts` |
| 6 | `packages/tui/CHANGELOG.md` |
| 6 | `scripts/bazel-natives.ts` |
| 5 | `HANDOFF.md` |
| 5 | `packages/coding-agent/src/utils/image-resize.ts` |
| 5 | `packages/coding-agent/test/auth-broker-migrate.test.ts` |
| 5 | `packages/coding-agent/test/internal-urls/issue-pr-protocol.test.ts` |
| 5 | `packages/coding-agent/test/model-config-live-headers.test.ts` |
| 5 | `packages/coding-agent/test/token-mcp-oauth-refresh.test.ts` |
| 5 | `packages/natives/scripts/build-bindings.ts` |
| 5 | `packages/tui/test/debug-server.test.ts` |
| 4 | `.omp/tools/tui.ts` |
| 4 | `bazel/toolchains/msvc/sysroot.bzl` |
| 4 | `crates/pi-natives/src/applefm/build-bridge.sh` |
| 4 | `crates/pi-shell/src/minimizer/config.rs` |
| 4 | `crates/pi-shell/tests/nonutf8_env.rs` |
| 4 | `packages/coding-agent/CHANGELOG.md` |
| 4 | `packages/coding-agent/src/cli/auth-gateway-cli.ts` |
| 4 | `packages/coding-agent/src/mcp/timeout.ts` |
| 4 | `packages/coding-agent/src/session/auth-broker-config.ts` |
| 4 | `packages/coding-agent/src/tiny/title-protocol.ts` |
| 4 | `packages/coding-agent/test/autoresearch-state.test.ts` |
| 4 | `packages/coding-agent/test/cli/worktree-clear-isolation.test.ts` |
| 4 | `packages/coding-agent/test/collab/helpers/registry-host-process.ts` |
| 4 | `packages/coding-agent/test/session/session-worktree.test.ts` |
| 4 | `packages/coding-agent/test/task/discovery.test.ts` |
| 4 | `packages/coding-agent/test/tools/bash-interactive.test.ts` |
| 4 | `packages/coding-agent/test/tools/gh-cache-invalidation.test.ts` |
| 4 | `packages/natives/CHANGELOG.md` |
| 4 | `packages/utils/src/logger.ts` |
| 4 | `packages/utils/test/logger-contract.test.ts` |
| 4 | `packages/utils/test/logger-no-transports.test.ts` |
| 3 | `crates/pi-shell/src/shell.rs` |
| 3 | `docs/mcp-config.md` |
| 3 | `docs/mcp-protocol-transports.md` |
| 3 | `docs/mcp-runtime-lifecycle.md` |
| 3 | `docs/natives-build-release-debugging.md` |
| 3 | `docs/tools/github.md` |
| 3 | `nix/package.nix` |
| 3 | `packages/ai/CHANGELOG.md` |
| 3 | `packages/coding-agent/scripts/mars` |
| 3 | `packages/coding-agent/scripts/omp` |
| 3 | `packages/coding-agent/src/discovery/claude-plugins.ts` |
| 3 | `packages/coding-agent/src/discovery/substitute-plugin-root.ts` |
| 3 | `packages/coding-agent/src/launch/protocol.ts` |
| 3 | `packages/coding-agent/src/security/provenance.ts` |
| 3 | `packages/coding-agent/src/session/redis-session-storage.ts` |
| 3 | `packages/coding-agent/test/advisor-toggle.test.ts` |
| 3 | `packages/coding-agent/test/collab/registry-smoke.test.ts` |
| 3 | `packages/coding-agent/test/marketplace/substitute-plugin-root.test.ts` |
| 3 | `packages/coding-agent/test/sdk-restricted-extension-provider.test.ts` |
| 3 | `packages/coding-agent/test/session/redis-session-storage-manager.test.ts` |
| 3 | `packages/coding-agent/test/session/redis-session-storage.test.ts` |
| 3 | `packages/coding-agent/test/usage-cli-history.test.ts` |
| 3 | `packages/tui/test/keybindings-migration.test.ts` |
| 3 | `packages/utils/CHANGELOG.md` |
| 3 | `packages/utils/src/env.ts` |
| 3 | `packages/utils/test/fixtures/logger-fixed-date-preload.ts` |
| 3 | `packages/utils/test/fixtures/stderr-guard-rotation-probe.ts` |
| 3 | `scripts/ci-macos-upload-secrets.sh` |
| 3 | `scripts/ci-test-ts.test.ts` |
| 3 | `sdk/go/omp-rpc/smoke_test.go` |
| 2 | `crates/pi-builtins/src/grep.rs` |
| 2 | `crates/pi-natives/src/grep.rs` |
| 2 | `crates/pi-natives/src/oauth_callback/mod.rs` |
| 2 | `crates/pi-voice/src/audio.rs` |
| 2 | `docs/local-models.md` |
| 2 | `docs/macos-signing-notarization.md` |
| 2 | `docs/models.md` |
| 2 | `infra/docs/04-arc-and-caching.md` |
| 2 | `packages/ai/test/auth-broker-nested-config.test.ts` |
| 2 | `packages/ai/test/auth-gateway-anthropic-caching.test.ts` |
| 2 | `packages/ai/test/auth-gateway-anthropic-to-codex-caching.test.ts` |
| 2 | `packages/ai/test/auth-gateway-cross-protocol-caching.test.ts` |
| 2 | `packages/ai/test/auth-gateway-openai-responses-caching.test.ts` |
| 2 | `packages/catalog/scripts/generate-models.ts` |
| 2 | `packages/coding-agent/scripts/mars.ts` |
| 2 | `packages/coding-agent/scripts/omp.ts` |
| 2 | `packages/coding-agent/src/blob-broker/protocol.ts` |
| 2 | `packages/coding-agent/src/cli/auth-broker-cli.ts` |
| 2 | `packages/coding-agent/src/config/model-settings.ts` |
| 2 | `packages/coding-agent/src/lsp/mux/protocol.ts` |
| 2 | `packages/coding-agent/src/modes/controllers/input-controller.ts` |
| 2 | `packages/coding-agent/src/predict/protocol.ts` |
| 2 | `packages/coding-agent/src/subprocess/worker-client.ts` |
| 2 | `packages/coding-agent/src/utils/image-loading.ts` |
| 2 | `packages/coding-agent/test/agent-storage-model-perf.test.ts` |
| 2 | `packages/coding-agent/test/auth-broker-live-settings.test.ts` |
| 2 | `packages/coding-agent/test/autoresearch-before-agent-start.test.ts` |
| 2 | `packages/coding-agent/test/collab/controller.test.ts` |
| 2 | `packages/coding-agent/test/discovery/builtin-tools.test.ts` |
| 2 | `packages/coding-agent/test/discovery/claude-plugins.test.ts` |
| 2 | `packages/coding-agent/test/discovery/disabled-extensions.test.ts` |
| 2 | `packages/coding-agent/test/eval/process-entry-import.test.ts` |
| 2 | `packages/coding-agent/test/fatal-stderr-pty.test.ts` |
| 2 | `packages/coding-agent/test/fixtures/cli-initial-title-probe.ts` |
| 2 | `packages/coding-agent/test/fixtures/crash-after-init-mcp.ts` |
| 2 | `packages/coding-agent/test/launch/broker-metadata-writes.test.ts` |
| 2 | `packages/coding-agent/test/main-cross-project-resume.test.ts` |
| 2 | `packages/coding-agent/test/mcp-long-wait.test.ts` |
| 2 | `packages/coding-agent/test/non-interactive-env.test.ts` |
| 2 | `packages/coding-agent/test/session-manager-cwd-adoption.test.ts` |
| 2 | `packages/coding-agent/test/session/picker-worktrees.test.ts` |
| 2 | `packages/coding-agent/test/tools/browser-launch.test.ts` |
| 2 | `packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts` |
| 2 | `packages/coding-agent/test/tools/read-pdf-line-range.test.ts` |
| 2 | `packages/coding-agent/test/utils/markit-cache.test.ts` |
| 2 | `packages/coding-agent/test/web/search/cli-provider-settings.test.ts` |
| 2 | `packages/metaharness/README.md` |
| 2 | `packages/metaharness/src/tb/trial.ts` |
| 2 | `packages/tui/src/chat/image-loading.ts` |
| 2 | `packages/utils/src/ptree.ts` |
| 2 | `packages/utils/test/dirs-xdg.test.ts` |
| 2 | `packages/utils/test/fixtures/logger-contract-probe.ts` |
| 2 | `packages/utils/test/natives-dir-override.test.ts` |
| 2 | `packages/utils/test/ptree-timeout.test.ts` |
| 2 | `scripts/edit_benchmark_common.py` |
| 2 | `scripts/rate-edit-tool.py` |
| 1 | `.github/actions/bazel-cache/action.yml` |
| 1 | `Dockerfile` |
| 1 | `bazel/toolchains/swift/applefm.bzl` |
| 1 | `crates/pi-builtins/src/rg.rs` |
| 1 | `crates/pi-natives/src/applefm/mod.rs` |
| 1 | `crates/pi-natives/src/desktop/macos/capture/screen_capture_kit.rs` |
| 1 | `crates/pi-natives/src/highlight.rs` |
| 1 | `crates/pi-natives/src/shell.rs` |
| 1 | `docs/ERRATA-GPT5-HARMONY.md` |
| 1 | `docs/cli-reference.md` |
| 1 | `docs/config-usage.md` |
| 1 | `docs/context-files.md` |
| 1 | `docs/mcp-server-tool-authoring.md` |
| 1 | `docs/natives-text-search-pipeline.md` |
| 1 | `docs/porting-to-natives.md` |
| 1 | `docs/providers.md` |
| 1 | `docs/tools/task.md` |
| 1 | `packages/ai/src/utils/harmony-leak.ts` |
| 1 | `packages/ai/test/helpers/index.ts` |
| 1 | `packages/coding-agent/src/autoresearch/storage.ts` |
| 1 | `packages/coding-agent/src/cli/help-extra.ts` |
| 1 | `packages/coding-agent/src/cli/usage-cli.ts` |
| 1 | `packages/coding-agent/src/discovery/omp-plugins.ts` |
| 1 | `packages/coding-agent/src/ida/protocol.ts` |
| 1 | `packages/coding-agent/src/mcp/client.ts` |
| 1 | `packages/coding-agent/src/mcp/manager.ts` |
| 1 | `packages/coding-agent/src/mcp/transports/header-policy.ts` |
| 1 | `packages/coding-agent/src/mcp/transports/http.ts` |
| 1 | `packages/coding-agent/src/mnemopi/embed-client.ts` |
| 1 | `packages/coding-agent/src/modes/print-mode.ts` |
| 1 | `packages/coding-agent/src/sdk.ts` |
| 1 | `packages/coding-agent/src/task/settings.ts` |
| 1 | `packages/coding-agent/src/tools/browser/tab-protocol.ts` |
| 1 | `packages/coding-agent/src/web/search/index.ts` |
| 1 | `packages/coding-agent/test/cli-unsettled-command.test.ts` |
| 1 | `packages/coding-agent/test/direnv.test.ts` |
| 1 | `packages/coding-agent/test/discovery/builtin-home-walkup.test.ts` |
| 1 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` |
| 1 | `packages/coding-agent/test/fixtures/browser-executable-probe.ts` |
| 1 | `packages/coding-agent/test/fixtures/js-process-entry-import.ts` |
| 1 | `packages/coding-agent/test/fixtures/security/seeded-repository/src/fake-secret.ts` |
| 1 | `packages/coding-agent/test/issue-5879-legacy-event-stream-factory.test.ts` |
| 1 | `packages/coding-agent/test/legacy-pi-extension-cache.test.ts` |
| 1 | `packages/coding-agent/test/main-initial-message-title.test.ts` |
| 1 | `packages/coding-agent/test/mcp-reconnect-storm.test.ts` |
| 1 | `packages/coding-agent/test/mcp-startup-no-block.test.ts` |
| 1 | `packages/coding-agent/test/sdk-agent-dir-rules.test.ts` |
| 1 | `packages/coding-agent/test/session-manager/snapcompact-frame-lazy-resolution.test.ts` |
| 1 | `packages/coding-agent/test/skills.test.ts` |
| 1 | `packages/coding-agent/test/task/focused-subagent-manual-yield.test.ts` |
| 1 | `packages/coding-agent/test/task/parked-subagent-session-release.test.ts` |
| 1 | `packages/coding-agent/test/task/parked-subagent-shell-release.test.ts` |
| 1 | `packages/metaharness/src/tb/agent.ts` |
| 1 | `packages/natives/native/index.d.ts` |
| 1 | `packages/stats/test/server-embedded-client.test.ts` |
| 1 | `packages/tui/src/debug-server.ts` |
| 1 | `packages/tui/src/setup/wizard.ts` |
| 1 | `packages/tui/src/tui.ts` |
| 1 | `packages/tui/test/composer-cache.test.ts` |
| 1 | `packages/tui/test/native/blobs.test.ts` |
| 1 | `packages/utils/test/browsers.test.ts` |
| 1 | `packages/utils/test/postmortem-cleanup-error.test.ts` |
| 1 | `packages/utils/test/stderr-guard.test.ts` |
| 1 | `python/robomp/src/worker.py` |
| 1 | `scripts/ci-update-brew-formula.ts` |
| 1 | `scripts/fix-changelogs.test.ts` |
| 1 | `scripts/fix-changelogs.ts` |
| 1 | `scripts/install-tests/run-ci.sh` |
| 1 | `scripts/rebrand-codemod.py` |
| 1 | `scripts/setup.ts` |
| 1 | `sdk/go/omp-rpc/README.md` |

## Notes

- `PI_PROFILE` and every other `PI_*` variable keep their names. `PI_CONFIG_DIR`
  keeps its name but its default value moves from `.omp` to `.mars`; tests that set
  `PI_CONFIG_DIR` to an `.omp`-flavored value are updated alongside the config-dir
  work.
- `OMP_`, `OMP_BENCH_`, and `OMP_AUTH_BROKER_` appear bare (no suffix) in comments
  and docs where they name a family of variables. These are the same word token, so
  the codemod rewrites them to `MARS_`, `MARS_BENCH_`, `MARS_AUTH_BROKER_`.
- `REBRAND_AUDIT.md` and `HANDOFF.md` counts above are historical working notes;
  they are rewritten along with everything else.
- Out of scope (kept): `omp://` scheme, role `omp.*` tokens, `__omp_worker_*` argv
  selectors, `crates/pi-*` names, package folder names, LICENSE/copyright lines.
