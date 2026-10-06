# Running the smoke gate

`pnpm smoke:ci` builds the workspace and runs the full gate. CI builds first and calls
`shard.mjs` for its assigned partition.

## Shard assignment

`ci-suite-costs.json` records each suite's measured CI duration and pins it to a shard. A suite
with no entry keeps its old rule: its index in the frozen `ci-suites.txt`, or a hash of its name
for a fragment. Pins apply only under the shard count the table records.

Once a suite is pinned, only an edit to the table moves it. A new suite has no cost yet, so it
lands on its hash shard, and `pnpm check:shard-stability` names that shard and prints the measured
minutes per shard.
When the shards drift apart, download the latest smoke job logs and rebalance:

```bash
gh api repos/Cotal-AI/Cotal/actions/jobs/<job-id>/logs > shard-0.log   # one per smoke shard job
node bin/smoke/rebalance-shards.mjs shard-*.log
```

The script takes each suite's median duration across the logs. While the heaviest shard holds a
suite smaller than its gap to the lightest shard, it moves the suite closest to half that gap.
Commit the table. The stability check reports each pinned move as `REBALANCED` and still fails
any move the table does not pin.

## Pooled suites

On Linux, the runner can first overlap `smoke:attach-stdin`, `smoke:opencode` and
`smoke:delivery-starvation` when at least two of them belong to the partition and the worker
budget allows it. The default uses up to three workers and leaves at least one CPU outside
that budget when more than one is available.
Other suites, including `smoke:attach-reconnect`, run serially after the pool.

Set `SMOKE_CI_JOBS=1` to retain the original serial order. Values from 1 to 3 are accepted;
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
SIGINT, SIGTERM and SIGHUP also stop the pool and return a nonzero status. The starvation
suite stops its detached daemon groups on exit and on those signals, including paused groups.
Broker and custodian leaks remain failures. Existing suite watchdogs and the CI job timeout
remain in force.

## Platform skips

A suite that cannot run on the current platform ends through `skipSuite(reason)` from
`@cotal-ai/smoke-kit`, which prints `COTAL_SMOKE_SENTINEL skipped=<reason>` and exits 0. The
shard adds no cell for it, counts it as skipped in the completion line, and lists each skipped
suite with its reason under that line. A skip that printed a cell count would be reported as a
covered pass.
`skipSuite` throws when the reason would not read back as that one skip line, such as a reason
with a line break, because the shard grades the last sentinel line a suite prints.

## Failure reports

A shard stops at its first failing suite. It names that suite, lists the planned suites that
never started, and prints how many of its planned suites started. Under GitHub Actions it also
emits an error annotation with the failing suite and that count. The Windows smoke lane continues
on error, so its job reports success over a red shard, and the annotation on the run summary is
where that job states its coverage.

`pnpm smoke:ci:offline` keeps its existing live-suite exclusions and reports them. It is
not the full gate or a replacement name for a smaller testing tier.

## Workspace commands

Use the repository's pinned pnpm version. Recursive package tasks start when their
own declared prerequisites finish, within pnpm's worker limit. They need not wait
for unrelated packages in the same dependency group. Nested test workers have
separate budgets; the package limit is not a limit on every child process.

Declare test imports from another workspace package as development dependencies.
This keeps a test that rebuilds a bundle ahead of dependent tests that import it.
Do not discard dependency ordering to increase concurrency.

`pnpm typecheck` builds before checking source and smoke types. `pnpm build` runs
the declared package builds. Build a fresh checkout before running `pnpm test`;
some package tests also rebuild their own outputs.

`pnpm test` includes deterministic unit checks and integration checks using files,
sockets, processes, PTYs, native modules and bundles. It does not replace the full
smoke gate's broker, manager and agent scenarios.

## Packing seat from a checkout

`pnpm build` compiles the `@cotal-ai/seat` helper for the host arch only, and seat's `prepack`
refuses a tree without both `linux-x64` and `linux-arm64`. A suite that packs the closure from a
checkout, such as `smoke:seed-tarball:live`, packs seat from a clone in its own temporary root and
writes a 20-byte ELF header there for each arch the host build did not make. It never writes
`packages/seat/build/Release`, where a stand-in helper would ship on a later real pack.
