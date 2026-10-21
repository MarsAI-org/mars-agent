# orchestrate

> Run a plan of independent tasks across multiple worker agents, with file leases, a token budget, and a verification gate before a task counts as done.

## Source
- Entry: `packages/coding-agent/src/tools/orchestrate.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/orchestrate.md`
- Key collaborators:
  - `packages/coding-agent/src/orchestrator/engine.ts` — deterministic scheduler: task board, leases, concurrency, budget, verification.
  - `packages/coding-agent/src/orchestrator/verifier.ts` — `ShellVerifier` runs the configured check list and returns a verdict.
  - `packages/coding-agent/src/orchestrator/native-runner.ts` — `createNativeOrchestrationEngine`, the production construction point.
  - `packages/coding-agent/src/orchestrator/task-board.ts` — dependency gating and task state.
  - `packages/coding-agent/src/orchestrator/lease-manager.ts` — exclusive write leases per path.
  - `packages/coding-agent/src/orchestrator/budget.ts` — token and request ceilings.
  - `packages/coding-agent/src/orchestrator/message-bus.ts` — typed messages between workers.
  - `packages/coding-agent/src/orchestrator/settings.ts` — `orchestrator.*` settings, including the master switch.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates availability.

## Availability

Off by default. The tool is registered only when `orchestrator.enabled` is true and the session may still spawn subagents at its current task depth. With the setting off, the engine is never constructed and the session stays on the single-agent path.

## Inputs

| Field | Required | Effect |
| --- | --- | --- |
| `goal` | yes | One sentence describing the whole run. Carried into the plan id and the log. |
| `tasks` | yes | Non-empty array of tasks. See below. |
| `workers` | no | Worker specs. Defaults to one worker named `worker-1`. |

Each task:

| Field | Required | Effect |
| --- | --- | --- |
| `id` | yes | Stable task id; must be unique across the plan. |
| `title` | yes | Short label used in the report. |
| `description` | yes | What the worker must do; becomes the worker's assignment. |
| `dependencies` | no | Task ids that must finish first. A dependent stays blocked until all of them complete. |
| `targetFiles` | no | Paths this task writes. The lease manager grants exclusive write leases, so two tasks touching one file serialize instead of racing. |
| `agent` | no | Worker id from `workers`, or a role label the engine can match. Defaults to the first free worker. |

Each worker:

| Field | Required | Effect |
| --- | --- | --- |
| `id` | yes | Stable worker id. A task's `agent` matches this. |
| `roleLabel` | no | Human label such as `frontend`. Defaults to `id`. |
| `isolated` | no | Run this worker in its own checkout (worktree or CoW clone) and merge its branch afterwards. Defaults to `false`. |

## Validation

The plan is checked before any worker starts, so a malformed plan never spends budget:

- duplicate task id
- dependency on an unknown task
- a task that depends on itself
- a dependency cycle
- a plan with no workers

## Execution

1. Ready tasks are considered in board insertion order, so the same plan and the same worker behaviour always produce the same start sequence.
2. A task acquires write leases on its `targetFiles` before its worker starts. A task that cannot get a lease stays pending until the holder releases it.
3. Concurrency is bounded by `orchestrator.concurrency`, and further narrowed on Android by `orchestrator.androidProcessCap` to `floor((cap - 1) / 2)`.
4. A worker that exits zero is passed to the verifier. A worker that exits non-zero is never verified: its tree is incomplete, so check output would mislead.
5. A task whose verification fails is marked `failed`, and anything depending on it is cancelled.
6. When workers ran with `isolated: true`, the **integrator** lands their branches onto the target checkout in plan order, cherry-picking each commit. A branch that fails to merge demotes its task to `failed`. Clean branches have their temporary worktree deleted; a conflicting branch keeps its worktree for inspection.
7. Budget exhaustion stops the run before new workers start and is reported as `stoppedReason`.

## Output

Text summary plus structured details:

- `planId`, `stoppedReason`
- per task: `state`, `workerId`, `exitCode`, `error`
- `usage`: total tokens and request count

## Related

- `task` — one delegated job. Simpler and cheaper; prefer it unless the work genuinely splits into independent pieces that touch different files.
- `integrator` — the bundled agent that owns the merge and worktree cleanup.
- `docs/ORCHESTRATOR_DESIGN.md` — full design.
