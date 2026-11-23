# orchestrate

> Run a plan of independent tasks across multiple worker agents (`Mars Swarm`), with file leases, a token/request/wall-clock budget, and a verification retry gate before a task counts as done.

## Source
- Entry: `packages/coding-agent/src/tools/orchestrate.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/orchestrate.md`
- Key collaborators:
  - `packages/coding-agent/src/orchestrator/engine.ts` — deterministic DAG scheduler: task board, file leases, concurrency, budget, verification retry loop, and incremental/final branch integration.
  - `packages/coding-agent/src/orchestrator/verifier.ts` — `ShellVerifier` runs the configured check list (in the worker's worktree/branch or project root) and returns a verdict.
  - `packages/coding-agent/src/orchestrator/native-runner.ts` — `createNativeOrchestrationEngine`, the production construction point.
  - `packages/coding-agent/src/orchestrator/git-integrator.ts` — deterministic cherry-pick branch landing with optional `integrator` subagent conflict fallback.
  - `packages/coding-agent/src/orchestrator/run-store.ts` — in-memory live run registry and on-disk `SwarmRunStore` (`~/.mars/agent/swarms/<planId>/`).
  - `packages/coding-agent/src/orchestrator/spec-loader.ts` — declarative YAML/JSON swarm workflow parser and compiler.
  - `packages/coding-agent/src/orchestrator/task-board.ts` — dependency gating, topological sorting, and task retry state.
  - `packages/coding-agent/src/orchestrator/lease-manager.ts` — exclusive write leases per path.
  - `packages/coding-agent/src/orchestrator/budget.ts` — token, request, and wall-clock ceilings.
  - `packages/coding-agent/src/orchestrator/message-bus.ts` — typed messages between workers (bridged to `IrcBus` when active).
  - `packages/coding-agent/src/orchestrator/settings.ts` — `orchestrator.*` settings, including the master switch.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates availability.

## Availability

Off by default. The tool is registered when `orchestrator.enabled` is true and the session may still spawn subagents at its current task depth. With the setting off, the engine is never constructed and the session stays on the single-agent path.

`/swarm` (or its `/orchestrate` alias) toggles and controls swarm mode from inside an interactive session without a restart:

| Command | Effect |
| --- | --- |
| `/swarm on` | Set `orchestrator.enabled`, reconcile builtin tools, and activate the `orchestrate` tool for the next turn. |
| `/swarm off` | Clear the setting and drop the tool. Every other active tool stays selected. |
| `/swarm status` | Show the mode, fan-out policy, effective worker cap, and any active swarm run. |
| `/swarm mode <auto\|single\|parallel>` | Set `orchestrator.mode`. |
| `/swarm workers <1..64>` | Set `orchestrator.maxConcurrency`. |
| `/swarm board [planId]` | Open the fullscreen live Swarm Board overlay (`q`/`Esc` detaches, `X` stops the run). |
| `/swarm runs` | List recent persisted swarm runs from `SwarmRunStore`. |
| `/swarm run <spec-file>` | Load and validate a YAML/JSON swarm spec, enable swarm mode, and submit the plan for execution. |
| `/swarm resume <planId>` | Load a persisted run, strip already-completed tasks, and submit the remaining DAG for execution. |

## Settings (`orchestrator.*`)

| Setting | Default | Description |
| --- | --- | --- |
| `orchestrator.enabled` | `false` | Master switch exposing the `orchestrate` tool. |
| `orchestrator.mode` | `"auto"` | Fan-out policy (`"auto"`, `"single"`, `"parallel"`). |
| `orchestrator.maxConcurrency` | `4` | Maximum concurrent workers (narrowed to `2` on Android/Termux). |
| `orchestrator.androidProcessCap` | `6` | Total child process cap on Android/Termux (`floor((cap - 1) / 2)` worker slots). |
| `orchestrator.maxRetries` | `1` | Automatic retries when a worker's output fails verification checks (`0` disables retries). |
| `orchestrator.verificationChecks` | `[]` | Ordered shell commands a worker's output must pass before settling as `completed`. |
| `orchestrator.allowProjectVerificationChecks` | `false` | Whether repo-local project settings files are trusted to supply `verificationChecks`. |
| `orchestrator.conflictResolution` | `"integrator-agent"` | How git cherry-pick conflicts are handled (`"integrator-agent"` or `"none"`). |
| `orchestrator.maxTokens` | `0` | Total token budget for one run (`0` = unlimited). |
| `orchestrator.maxRequests` | `0` | Total provider request budget for one run (`0` = unlimited). |
| `orchestrator.maxWallClockMs` | `0` | Wall-clock timeout in milliseconds for one run (`0` = unlimited). |

## Verification gate and retry loop

`orchestrator.verificationChecks` holds shell commands that a worker's output must
pass before its task may settle as completed. They run in order against the
worker's isolated checkout (or a temporary detached worktree of the worker's
`branchName` before integration, or the working directory for non-isolated
workers), stopping at the first failure.

When a check fails and the task has remaining retries (`orchestrator.maxRetries`),
the engine transitions the task back to `pending`, increments its attempt count,
and passes the failing check's command and output as `retryFeedback` on the next
worker run. Once retries are exhausted, a rejected task settles as `failed` and
reports `verificationFailure`.

## Inputs

| Field | Required | Effect |
| --- | --- | --- |
| `goal` | yes | One sentence describing the whole run. Carried into the plan id and the log. |
| `tasks` | yes | Non-empty array of tasks. See below. |
| `workers` | no | Worker specs. When omitted, workers are auto-provisioned from distinct `task.agent` ids or sized to the independent root tasks up to `orchestrator.maxConcurrency`. |

Each task:

| Field | Required | Effect |
| --- | --- | --- |
| `id` | yes | Stable task id; must be unique across the plan. |
| `title` | yes | Short label used in the report and board pane. |
| `description` | yes | What the worker must do; becomes the worker's assignment. |
| `dependencies` | no | Task ids that must finish first. A dependent stays blocked until all of them complete. |
| `targetFiles` | no | Paths this task writes. The lease manager grants exclusive write leases, so two tasks touching one file serialize instead of racing. |
| `agent` | no | Worker id from `workers`, or a role label / agent name the engine can match. Defaults to the first free worker. |

Each worker:

| Field | Required | Effect |
| --- | --- | --- |
| `id` | yes | Stable worker id. A task's `agent` matches this. |
| `roleLabel` | no | Human label such as `frontend`. Defaults to `id`. |
| `agent` | no | Bundled or project agent definition name. Defaults to the session's default spawn agent. |
| `model` | no | Model selector or role alias (e.g. `@smol`, `anthropic/claude-sonnet-4-5`) for this worker. |
| `tools` | no | Requested tool names for this worker, intersected with the parent session's active tools. |
| `isolated` | no | Run this worker in its own checkout (worktree or CoW clone) and merge its branch afterwards. Defaults to `false` (auto-enabled when tasks declare overlapping `targetFiles`). |

## Validation

The plan is checked before any worker starts, so a malformed plan never spends budget:

- duplicate task id or duplicate worker id
- dependency on an unknown task
- a task that depends on itself
- a dependency cycle
- a plan with no workers

## Execution

1. Ready tasks are considered in board insertion order, so the same plan and the same worker behaviour always produce the same start sequence.
2. A task acquires write leases on its `targetFiles` before its worker starts. A task that cannot get a lease stays pending until the holder releases it.
3. Concurrency is bounded by `orchestrator.maxConcurrency`, and further narrowed on Android by `orchestrator.androidProcessCap` to `floor((cap - 1) / 2)`.
4. A worker that exits zero is passed to the verifier (running against the isolated branch/worktree when isolated). A worker that exits non-zero is never verified.
5. A task whose verification fails is retried up to `orchestrator.maxRetries` times with diagnostic feedback; if still failing, it is marked `failed` and its transitive dependents are cancelled.
6. When workers ran with `isolated: true`, `GitIntegrator` cherry-picks their commits onto the target checkout in topological dependency order (incrementally before dependent tasks start, and finally when the plan settles). If a cherry-pick conflict occurs and `orchestrator.conflictResolution` is `"integrator-agent"`, the bundled **integrator** agent is invoked to resolve the conflict.
7. Run state and per-task logs are persisted under `~/.mars/agent/swarms/<planId>/` via `SwarmRunStore`.

## Output

Text summary plus structured details:

- `planId`, `stoppedReason`
- per task: `state`, `workerId`, `exitCode`, `error`, `verificationFailure`
- `usage`: total tokens and request count

## Related

- `task` — one delegated job. Simpler and cheaper; prefer it unless the work genuinely splits into independent pieces that touch different files.
- `integrator` — the bundled agent that resolves cherry-pick conflicts and cleans up worktrees.
- [`docs/swarm.md`](../swarm.md) — full Mars Swarm architecture, declarative YAML/JSON specs, `/swarm` interactive commands, and headless `mars swarm` CLI.
