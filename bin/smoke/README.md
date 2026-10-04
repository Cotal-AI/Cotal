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

`pnpm smoke:ci:offline` keeps its existing live-suite exclusions and reports them. It is
not the full gate or a replacement name for a smaller testing tier.

## Suites that can fail

A run cannot show that a suite swallowed a throw or lost a cell, so `pnpm smoke:gate-inventory`
reads the entry file of every suite the gate reaches and refuses two shapes. It accepts only the
forms below, because a form it cannot follow to the exit status can hide either defect.

- A `finally`, or a promise `.finally`, that calls `process.exit` with a status that can be 0, where
  a throw in that `try` would exit 0. A catch arm prevents it only when its first statement exits
  with a failing status, or sets `process.exitCode` to one that the exit reads (`process.exit()`,
  `process.exit(process.exitCode)` or `process.exit(process.exitCode ?? 0)`) while nothing in the
  arm or the `finally` writes another code, including `++`, `--` and destructuring. A statement
  before it can throw past it, so log after failing. A statement inside a branch of the arm, a
  computed code and a rethrow do not count. A promise `.catch` counts only directly before
  `.finally`. A status variable that starts failing counts when the only write that clears it is
  the last statement of the `try`.
- A suite with no pinned cell count. Declare `const EXPECTED_CELLS = <n>`, never reassign it, and
  compare the cells that ran with it by equality, after reporting failures, so a deleted cell turns
  the suite red. The comparison is the whole condition of a statement every run reaches, and a
  mismatch fails the run in one of four forms: `if (ran !== EXPECTED_CELLS)` with an arm that always
  runs `process.exit(1)`; the same arm setting `process.exitCode = 1`, when the file writes no other
  code and every `process.exit` that can follow reads it; the same arm throwing, outside any
  function or `try` with a catch; or `process.exit(ran === EXPECTED_CELLS ? 0 : 1)`. A statement
  before the failing one in the arm counts only where a throw would also escape.

A failing status is an integer from 1 to 255, written as a literal or a sum of literals. The process
keeps only the low eight bits of its status, so `process.exit(256)` exits 0. The `finally` exit's own
status may also add a lookup into an object literal of them, such as
`128 + { SIGINT: 2, SIGTERM: 15 }[signal]`, because a lookup that misses makes `process.exit` throw
rather than exit 0. Names resolve to the declaration they bind, so a parameter or inner function
that shadows the pin or `main` does not count, and neither does a generator, whose call runs none of
its body.

Every run reaches a statement of the file, of a bare block, of a `try` or `finally` block, or of the
body of a function that a reached statement calls (`main()`, `await main()`, `main().catch(...)`),
when no earlier statement in its block exits, throws or returns. An async function called without
`await` counts only when no later statement exits. A comparison in a branch, a loop, a callback, a
check function, a failure tally or a variable pins nothing.

The second rule applies to every suite not listed in `unpinned-suites.txt`. That list is the debt
that existed when the rule landed, and `UNPINNED_DIGEST` in the gate binds it to those entries. The
census refuses an entry that pins a count now or is no longer a reached suite until it is marked
`paid <path>`. A paid entry stays in the file and grandfathers nothing. A new or renamed suite pins
its count.

A reached suite whose script names no entry file the census can read, after quotes and
`-F <pkg> smoke:*` delegation are resolved, is refused unless `CENSUS_UNREAD` in the gate lists it
with a reason.

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
