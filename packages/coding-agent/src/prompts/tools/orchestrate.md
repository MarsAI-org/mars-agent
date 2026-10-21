Run a plan of independent tasks across multiple worker agents.

Use this when a goal splits into pieces that touch **different files** and can
run in parallel. For a single delegated job, use `task` instead — it is simpler
and cheaper.

Each task declares the files it writes. The orchestrator grants exclusive leases
on those paths, so two tasks that write the same file serialize instead of
racing. A task whose dependencies have not finished stays blocked.

Every worker runs as a real subagent with the session's tools, clamped to the
parent's permissions. A task only counts as completed when its worker exits zero
and its output passes the configured verification checks.

## Isolation and merging

Set `isolated: true` on a worker to run it in its own checkout (a worktree or a
copy-on-write clone). Isolated workers commit to their own branch, so parallel
edits never collide in a shared tree. When the plan settles, the orchestrator
spawns the **integrator** agent, which cherry-picks each worker branch onto the
target, resolves conflicts, verifies the merged tree, and deletes the temporary
branches and worktrees.

A task whose branch fails to merge is reported **failed**, not completed: its
code is not on the target, so claiming otherwise would be a lie.

Prefer isolation when:

- two tasks write files that are related but not identical (same module, same
  component) and you would rather merge than serialize
- you want to inspect or discard a worker's result before it lands

Skip it when the tasks are already disjoint and cheap: the merge adds a step
for no benefit.

## Reporting

Streamed updates carry one pane per worker: state, task, elapsed time, tokens,
isolation branch, and the tail of its output. Read them to see which worker is
stuck instead of waiting for the whole run.

Keep the plan flat unless there is a real ordering constraint: dependencies
reduce parallelism and lengthen the run.
