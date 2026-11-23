Run a plan of independent tasks across multiple worker agents (`Mars Swarm`).

Use this when a goal splits into pieces that touch **different files** and can
run in parallel. For a single delegated job, use `task` instead — it is simpler
and cheaper.

Each task declares the files it writes (`targetFiles`). The orchestrator grants
exclusive write leases on those paths, so two tasks that write the same file
serialize instead of racing. A task whose dependencies have not finished stays
blocked.

## Workers and auto-provisioning

If `workers` is omitted, the orchestrator automatically provisions workers from
the distinct `agent` ids referenced across `tasks` (or a default pool matching
the independent root tasks up to `orchestrator.maxConcurrency`).

When declaring `workers` explicitly, each worker can customize:
- `id` — stable worker identifier matched by `task.agent`
- `roleLabel` — display role shown in the live `/swarm board` pane
- `agent` — bundled or project agent definition name (defaults to the session spawn agent)
- `model` — optional model selector or role alias (e.g. `@smol`, `opus`)
- `tools` — optional subset of parent-active tools granted to this worker
- `isolated` — run in a dedicated git worktree/branch and merge on completion

Every worker runs as a real subagent clamped to the parent session's permissions.

## Verification and automatic retry loop

A task only counts as completed when its worker exits zero and its output passes
the configured verification checks (`orchestrator.verificationChecks`). For
isolated workers, verification runs inside the worker's worktree or branch
before integration.

When verification fails and retries remain (`orchestrator.maxRetries`, default 1),
the engine automatically re-queues the task with the failing command's diagnostic
output attached so the worker can fix the regression on its next attempt.

## Isolation and merging

Set `isolated: true` on a worker to run it in its own checkout (a worktree or a
copy-on-write clone). Isolated workers commit to their own branch, so parallel
edits never collide in a shared tree. When a task with downstream dependents
completes (or when the plan settles), the orchestrator lands each worker branch
onto the target in topological dependency order, falling back to the
**integrator** agent when `orchestrator.conflictResolution` is
`"integrator-agent"` and a cherry-pick conflict occurs.

A task whose branch fails to merge is reported **failed**, not completed: its
code is not on the target, so claiming otherwise would be a lie.

Prefer isolation when:

- two tasks write files that are related but not identical (same module, same
  component) and you would rather merge than serialize
- you want to inspect or discard a worker's result before it lands

Skip it when the tasks are already disjoint and cheap: the merge adds a step
for no benefit.

## Reporting and persistence

Streamed updates carry one pane per worker: state, task, elapsed time, tokens,
isolation branch, retry attempt count, and the tail of its output. Users can
open the interactive board with `/swarm board`, inspect persisted runs with
`/swarm runs`, or resume incomplete runs with `/swarm resume <planId>`.

Keep the plan flat unless there is a real ordering constraint: dependencies
reduce parallelism and lengthen the run.
