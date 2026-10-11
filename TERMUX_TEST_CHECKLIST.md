# Termux / Android Manual Test Checklist (Human, Real Device Required)

Everything device-dependent in this checklist is **UNVERIFIED** until a human runs
it on a real phone. CI can cover the code paths (platform detection, launcher
argument forwarding, missing-loader errors, LD_PRELOAD hygiene), but only a
physical device proves the end-to-end flow.

## 0. How to Set Up

1. Install Termux from **F-Droid** (the Play Store build is deprecated and
   blocks updates).
2. `pkg update && pkg upgrade`
3. `pkg install git curl`
4. For Tier 1 only: `pkg install glibc-repo && pkg install glibc-runner`
5. Copy the launcher and the binary to the Termux home (`$HOME`), never `/sdcard`.

Device version matrix:

| Tier | Android 12+ | Android 10 / 11 |
|---|---|---|
| Tier 1 (glibc runner) | Baseline target | Best effort (see risks) |
| Tier 2 (native Bionic) | Baseline target | Best effort |
| Tier 3 (Node runtime) | Not targeted in this milestone | Not targeted |

## 1. Tier 1 — Native Termux via glibc runner (no proot)

### 1.1 Installation
- [ ] `pkg install glibc-repo && pkg install glibc-runner` completes without error.
- [ ] Download the release `mars-linux-arm64` binary and its `SHA256SUMS.txt`.
- [ ] `sha256sum --ignore-missing --check SHA256SUMS.txt` passes.
- [ ] Binary installed under `$PREFIX/bin` or `$HOME/.local/bin` (NOT `/sdcard`).
- [ ] `sh mars-termux-launcher.sh --version` prints the version.

### 1.2 Self-check (run this first)
- [ ] `sh mars-termux-launcher.sh --platform-check` runs.
- [ ] Output shows `android: yes`, `termux: yes`, `termux prefix: …`.
- [ ] `glibc runner:` shows a resolved path (not `not found`).
- [ ] `shared storage in use: no`.
- [ ] `--platform-check --json` prints valid JSON.

### 1.3 Sessions
- [ ] Single-agent session: launch `mars` in a git repo, ask for a one-line edit,
      confirm the edit and commit succeed.
- [ ] Enable the orchestrator (`orchestrator.enabled: true`, mode auto) and run a
      two-worker task with disjoint write sets; confirm both workers complete and
      the status bar shows correct counts.
- [ ] Narrow terminal (phone portrait): confirm the TUI falls back below the
      80-column default and the tab strip switches workers.

### 1.4 Resilience
- [ ] Screen rotation does not crash the TUI.
- [ ] Opening/closing the virtual keyboard (SIGWINCH) does not corrupt the layout.
- [ ] With `termux-wake-lock` acquired, the session survives screen lock for a
      5-minute run.
- [ ] Battery and thermal notes recorded (see §4).

## 2. Tier 2 — Native Bionic build (when available)

Tier 2 requires a Bionic-capable JavaScript runtime and an
`aarch64-linux-android` native addon; both are external prerequisites. Only run
this section once those exist.

- [ ] `mars --platform-check` reports `android: yes` without the glibc runner
      (`glibc runner: not found` is acceptable here).
- [ ] Native addon loads (no `dlopen` error).
- [ ] Process listing works (`Process.from_pid` path on `target_os = "android"`).
- [ ] A `bash` tool command that needs a PTY either works or falls back to pipes
      with a clear message (record which).

## 3. Tier 3 — Node.js runtime (not built in this milestone)

- [ ] N/A in this milestone. See `ANDROID_RUNTIME_INVENTORY.md` for the cost
      estimate and API inventory.

## 4. What a Result Report Must Contain

For each item run, record:

1. Device model, SoC, Android version (build number), Termux version.
2. Tier attempted and the exact commands used.
3. Full output of `--platform-check --json`.
4. Pass/fail per checklist item, with the failing output pasted verbatim.
5. Battery delta (%) and whether the device throttled during multi-worker runs.
6. Screen orientation and keyboard-toggle behavior (screenshot or description).
7. Anything that worked on one Android version but not another.

Device-dependent facts (PTY behavior, process reaping thresholds, thermal curves,
`statx` on Android 10/11, wake-lock survival) are **UNVERIFIED** until reported
here; do not treat them as settled.

## 5. Known Risks to Probe Explicitly

| Risk | What to look for |
|---|---|
| Direct `statx` syscall on Android 10/11 | Spawn or file-watch failures; Android 12+ is the baseline |
| LD_PRELOAD injection (`libtermux-exec`) | Immediate loader crash if the launcher is bypassed |
| Missing ELF interpreter | `No such file or directory` when the binary is executed directly instead of via the loader |
| Background process reaping | Workers dying mid-run while the app is backgrounded |
| Shared storage execution failure | `Permission denied` when the binary sits on `/sdcard` |
| Pointer tagging (TBI/MTE) | Crashes inside any runtime on Tier 2 |
