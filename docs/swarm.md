# Mars Swarm (`orchestrator/`)

Mars Swarm is the multi-agent orchestration subsystem in `packages/coding-agent/src/orchestrator/`. It executes a directed acyclic graph (DAG) or sequential pipeline of tasks across parallel worker subagents with path-normalized file leases, token/request/wall-clock budgets, branch-isolated verification with automatic retries, topological git integration, live TUI board monitoring, and on-disk run persistence.

---

## Architecture Overview

| Module | Responsibility |
| --- | --- |
| `orchestrator/engine.ts` | Deterministic DAG scheduler (`OrchestrationEngine`): manages task readiness, exclusive file leases, worker concurrency, interim/settled budget enforcement, verification retry loops, and incremental/final branch integration. |
| `orchestrator/task-board.ts` | Tracks task states (`pending`, `blocked`, `running`, `completed`, `failed`, `cancelled`), execution attempt counts, retry requeueing (`requeueForRetry`), and Kahn topological ordering (`topologicalOrder`). |
| `orchestrator/lease-manager.ts` | Grants atomic read/write leases on normalized relative paths (`node:path.posix.normalize`), preventing path-alias races (`./a.ts` vs `a.ts`) and directory-containment overlaps (`src` vs `src/a.ts`). |
| `orchestrator/native-runner.ts` | Production `EngineRunner` (`NativeWorkerRunner` & `createNativeOrchestrationEngine`): spawns workers through `runStructuredSubagent`, enforces permission intersection, bridges `sendMessage` to `IrcBus`, and wires `ShellVerifier` and `GitIntegrator`. |
| `orchestrator/verifier.ts` | `ShellVerifier`: executes configured verification commands with process-group timeout termination and detached-worktree branch verification (`verifyBranch`). |
| `orchestrator/git-integrator.ts` | `GitIntegrator`: lands isolated worker branches in topological dependency order via `vcs.git` cherry-pick (`baseSha..branchName`) and invokes the bundled `integrator` subagent when `orchestrator.conflictResolution` is `"integrator-agent"`. |
| `orchestrator/run-store.ts` | In-memory live run registry (`registerLiveSwarmRun`, `getActiveSwarmRun`) and persistent on-disk store (`SwarmRunStore`, `buildResumePlan`) under `<agentDir>/swarms/<planId>/`. |
| `orchestrator/spec-loader.ts` | Parses and validates declarative YAML (`.yaml`/`.yml`) and JSON (`.json`/`.json5`) swarm specs (`parseSwarmSpec`, `loadSwarmSpec`, `specToOrchestratorPlan`). |
| `orchestrator/board-model.ts` | Folds `OrchestratorEvent` frames into `WorkerPane` snapshots consumed by `@marsai-org/tui/apps/orchestrator-board`. |
| `orchestrator/mode.ts` | In-session toggle and subcommand handler (`setOrchestratorMode`, `applyOrchestratorCommand`, `describeOrchestratorMode`). |

---

## Interactive `/swarm` Slash Commands

Inside an interactive Mars session, `/swarm` (and its backward-compatible alias `/orchestrate`) controls swarm orchestration without restarting the session:

```text
/swarm on                  Enable swarm mode, reconcile builtin tools, and expose `orchestrate`
/swarm off                 Disable swarm mode and remove `orchestrate` from active tools
/swarm status              Show mode, fan-out policy, effective worker cap, and active run progress
/swarm mode <policy>       Set fan-out policy: auto | single | parallel
/swarm workers <1..64>     Cap concurrent workers (narrowed to 2 on Android/Termux)
/swarm board [planId]      Open the fullscreen Swarm Board overlay
/swarm runs                List recent persisted swarm runs
/swarm run <spec-file>     Load and validate a YAML/JSON swarm spec and submit it for execution
/swarm resume <planId>     Resume incomplete or failed tasks from a persisted swarm run
```

### Live Swarm Board (`/swarm board`)

`/swarm board` mounts `OrchestratorBoardComponent` as a fullscreen TUI overlay attached to the active in-memory `LiveSwarmRun` (or the most recent persisted run if no live run is active):

- **`Tab` / `Shift+Tab` / `1`–`9`**: cycle or jump between worker panes.
- **`Enter`**: expand or collapse the focused worker's output tail.
- **`l`**: toggle between tiled multi-pane layout and focused single-pane layout.
- **`c`**: cancel the currently focused worker (`engine.cancelWorker(workerId)`) without aborting sibling workers.
- **`q` / `Esc`**: detach and close the board overlay while leaving the swarm running in the background.
- **`X` / `Ctrl+C`**: stop the entire swarm run (`engine.stopAll()`) and close the overlay.

---

## Declarative Swarm Specs (YAML / JSON)

Swarm workflows can be defined declaratively in YAML or JSON and executed via `/swarm run <file>` or `mars swarm run <file>`.

### Example `swarm.yaml`

```yaml
name: auth-refactor
goal: Refactor authentication middleware and add unit tests
mode: dag # "dag" (default) or "pipeline"
iterations: 1
maxConcurrency: 4
maxRetries: 1
isolated: true
verificationChecks:
  - bun run check

workers:
  - id: backend
    roleLabel: Backend Engineer
    agent: task
    model: "@default"
    tools: [read, edit, write, grep, glob]
    isolated: true
  - id: tester
    roleLabel: QA Engineer
    agent: task
    model: "@smol"
    tools: [read, edit, write, bash]
    isolated: true

tasks:
  - id: refactor-middleware
    title: Refactor auth middleware
    description: Extract token verification into src/auth/verify.ts
    targetFiles:
      - src/auth/middleware.ts
      - src/auth/verify.ts
    worker: backend

  - id: add-auth-tests
    title: Add unit tests for token verification
    description: Write unit tests covering expired and malformed tokens
    dependencies:
      - refactor-middleware
    targetFiles:
      - test/auth/verify.test.ts
    worker: tester
```

- **`mode: "dag"`**: tasks run as soon as their declared `dependencies` (or legacy alias `waits_for`) complete and their `targetFiles` (or `target_files`) leases are available.
- **`mode: "pipeline"`**: when tasks omit explicit dependencies, `specToOrchestratorPlan` automatically chains them sequentially (`task[i]` depends on `task[i - 1]`). Setting `iterations: N` (or legacy `target_count: N`) runs `N` sequential passes.
- **Auto-provisioned workers**: if `workers` is omitted, workers are synthesized automatically from distinct task `worker`/`agent` assignments.

---

## Headless CLI (`mars swarm`)

`mars swarm` validates, dry-runs, executes, inspects, and resumes swarm workflows from the terminal or CI pipelines:

```bash
# Validate a YAML or JSON swarm spec and print the resolved DAG
mars swarm validate ./swarm.yaml

# Dry-run a spec (prints the resolved execution plan without spawning models)
mars swarm run ./swarm.yaml --dry-run

# Execute a swarm spec headlessly with custom concurrency and fan-out mode
mars swarm run ./swarm.yaml --workers 4 --mode parallel

# List recent persisted swarm runs
mars swarm list

# Inspect per-task status, verification results, usage totals, and log previews
mars swarm status [planId]

# Preview or execute a resume plan for a failed/cancelled run
mars swarm resume <planId> --dry-run
mars swarm resume <planId>
```

All commands accept `--json` (`-j`) for machine-readable output and `--store-dir <dir>` to target an isolated run store directory.

---

## Persistent Runs and Resume (`SwarmRunStore`)

Every swarm execution persists its state under `<agentDir>/swarms/<planId>/` (default `~/.mars/agent/swarms/<planId>/`):

- `state.json` — `PersistedSwarmRun` record containing the plan, overall status (`running`, `completed`, `failed`, `cancelled`), `stoppedReason`, `UsageTotals`, and per-task outcomes (`state`, `workerId`, `exitCode`, `branchName`, `patchPath`, `baseSha`, `verification`, `usage`).
- `logs/<taskId>.log` — per-task execution transcript and verification check output.

When a run fails or is cancelled partway through, `buildResumePlan(run)` constructs a new `OrchestratorPlan` containing only tasks whose state is not `"completed"` and strips already-completed task IDs from the remaining tasks' `dependencies`.

---

## Verification Retries and Conflict Resolution

1. **Branch-Aware Verification**: when an isolated worker produces commits on `branchName`, `ShellVerifier.verifyBranch` checks out the branch in a temporary detached worktree before integration so verification commands test the worker's actual changes rather than the untouched parent checkout.
2. **Automatic Retry Loop**: if verification fails and `attempt <= maxRetries` (`orchestrator.maxRetries`, default `1`), the engine emits `task_retry`, attaches the failed check's command and output as `retryFeedback`, and re-queues the task on `TaskBoard`.
3. **Incremental & Topological Integration**: `GitIntegrator` cherry-picks completed isolated branches in topological dependency order (`baseSha..branchName`). When a completed isolated task has downstream pending dependents, the engine integrates its branch before starting the dependent tasks so downstream workers see upstream changes.
4. **Integrator Agent Fallback**: if `git cherry-pick` hits a merge conflict and `orchestrator.conflictResolution` is `"integrator-agent"`, `GitIntegrator` aborts the failed cherry-pick and dispatches the bundled `integrator` subagent to resolve the conflict cleanly.
