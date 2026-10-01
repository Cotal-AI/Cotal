# Running the smoke gate

`pnpm smoke:ci` builds the workspace and runs the full gate. CI builds first and calls
`shard.mjs` for its assigned partition. Suites keep their existing shard assignments.

On Linux, the runner can first overlap `smoke:attach-stdin` and `smoke:opencode` when both
belong to the partition and the worker budget allows it. The default uses up to two workers
and leaves at least one CPU outside that budget when more than one is available.
Other suites, including `smoke:attach-reconnect`, run serially after the pool.

Set `SMOKE_CI_JOBS=1` to retain the original serial order. Values from 1 to 2 are accepted;
other values throw. Other platforms use serial execution. A caller-pinned `COTAL_HOME`
or `COTAL_SEAT_ROOT` also keeps execution serial so the runner does not replace that pin.
Requesting multiple workers with either restriction throws and names the restriction.

Each pooled suite receives private home, configuration, cache, custody and temporary
paths. Its broker scope, custodian marker and process group are separate from its
siblings. The caller's effective Corepack cache is retained. Other environment values,
including test pins and budgets, remain inherited.

This is not a filesystem or network sandbox. The cohort is a reviewed set of suites
that use their own state and loopback brokers. Admission of another suite requires
checking its resource use and exercising it with the cohort. Matching a script path
alone does not establish isolation of its imports.

Within the pool, output is retained per suite and printed in declared order, with progress
notices while it runs. Each suite has a 32 MiB output limit. Nonzero exits, invalid sentinels
and output overflow stop admission and stop in-flight siblings. Their reports distinguish
stopped work from suites that never ran.
SIGINT, SIGTERM and SIGHUP also stop the pool and return a nonzero status. Broker and
custodian leaks remain failures. Existing suite watchdogs and the CI job timeout remain
in force.

`pnpm smoke:ci:offline` keeps its existing live-suite exclusions and reports them. It is
not the full gate or a replacement name for a smaller testing tier.
