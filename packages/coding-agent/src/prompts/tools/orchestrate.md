Run a plan of independent tasks across multiple worker agents.

Use this when a goal splits into pieces that touch **different files** and can
run in parallel. For a single delegated job, use `task` instead — it is simpler
and cheaper.

Each task declares the files it writes. The orchestrator grants exclusive leases
on those paths, so two tasks that write the same file serialize instead of
racing. A task whose dependencies have not finished stays blocked.

Every worker runs as a real subagent with the session's tools, clamped to the
parent's permissions. A task only counts as completed when its worker exits zero.

Keep the plan flat unless there is a real ordering constraint: dependencies
reduce parallelism and lengthen the run.
