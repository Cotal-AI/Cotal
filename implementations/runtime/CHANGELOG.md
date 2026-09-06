# @cotal-ai/runtime

## 0.46.0

### Minor Changes

- 18a0024: The manager hosts workflow runs. `run-start`, `run-resume`, `run-answer`, `run-status` and
  `run-ps` are served on the manager's endpoint rails; a run is validated before anything is
  recorded, driven in the manager's process under a per-run `run-driver` credential, and taken back
  from its journal after a manager restart. `cotal run` is a client of that surface by default,
  with `--local` keeping the in-process drive, now under the run's own `run-driver` and
  `run-operator` credentials rather than `admin`; an answer's writes are pinned to the one pause it
  answers. A user-auth mesh refuses the family by name until a run can carry its user's owner. A new `run` capability mints the family into an
  agent's credential and injects the `cotal_run` tool, so an agent can write a cotal-lang program
  and start it from a session. `run-answer` records the answerer from the caller's credential and
  takes no `by`; `cotal run answer` drops `--by` on the hosted path. `spawn({ supervise })` is a restart policy the manager enforces in
  place: `{ restarts, window? }` (default `10m`) until the budget is spent, then the seat is
  retired and the next `turn` is L4002. A policy this host cannot honour is refused at accept.

### Patch Changes

- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0
  - @cotal-ai/workspace@0.46.0
  - @cotal-ai/lang@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0
  - @cotal-ai/lang@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0
- @cotal-ai/workspace@0.44.0
- @cotal-ai/lang@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0
  - @cotal-ai/lang@0.43.0

## 0.42.0

### Minor Changes

- a87709c: Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
  the not-yet-durable seam is gone.

  `spawn` submits a real manager goal and returns the allocated seat's handle, and meters the
  agent's `permits` (`turns`, `wallClock`; the turn that would exceed one is L4001, and a budget the
  host cannot meter is refused at spawn); `conclave` opens a scoped sub-team as durable membership
  rows; `ask` parks schema-checked pauses answered through `cotal run answer` and tells the agent
  over the turn relay, one relay per attempt carrying the schema, the attempt and the previous
  refusal, which every connector's intake renders with the answer command; `monitor` registers the
  handle on its journal entry and `wait(down)` reads a monitored incarnation's death off presence
  liveness, refusing an agent nobody monitored.
  `turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
  despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
  10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
  at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
  two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
  `handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
  arms its own pause on the acceptance's deadline as the L4003 authority, watches presence as the
  L4002 authority (a death the manager marks on the deadline terminal reads the same way), and
  honors handoffs (L4005/L4004 validation, the `handoffFrom` goal chain); the manager shows a seat
  one turn at a time. The relay holds on an auth mesh: the agent baseline gains the self-mode
  `turn-pending` and `turn-yield` rows, the operator seat-write set (`control-caller-admin`, the
  `admin` capability) gains `turn` beside `input`, and the manager mints the deadline hold's
  schedule over its serve connection and owner-expires the hold once due instead of reading a
  fire it holds no grant for. `wait(replied)` observes the run's own turn terminals as a level, and never a
  turn the run itself ended without an accepted yield. A `spawn` may bind a logical worktree: the
  validator rejects two literal-worktree spawns in one concurrent scope (L3022, named branch
  functions included) and the runtime claims a tree before it submits, refusing a second spawn into
  a tree held by a live seat or by a spawn in flight (L4008), with sequential reuse the moment the
  holder's presence lapses. A spawn refused at accept is L4000 (L4001 for seat capacity) and one
  whose seat never came up is L4002; an `ask` whose deadline passes with no conforming record is
  L4006; a fork copies a spawn that said `onFork: "adopt"` and refuses one that would have to
  respawn (L5019). The run driver re-issues
  recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
  release a dead loser's seat, pause, or tree. A migration's `--adopt <handle>` hands the orphaned
  seat to the edited program's next spawn of that persona, and `--release <handle>` despawns it at
  commit through the run's own discharge; both name the agent the step spawned, and a spawn that
  produced none is an orphan like a sleep; the adopting spawn binds the orphaned spawn's goal as
  its own, so a resume re-reads the seat and a cancellation despawns it. A turn accept the manager
  cannot finish unwinds to a failed terminal on its bound goal, and a retry of it is refused naming
  that terminal. The delivery daemon hosts the checkpoint timer writer, so mediated deadlines fire
  with no suite pump.

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/lang@0.42.0
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4
- @cotal-ai/lang@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3
  - @cotal-ai/lang@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2
- @cotal-ai/lang@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1
- @cotal-ai/lang@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [42d80da]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/lang@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0
- @cotal-ai/lang@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1
- @cotal-ai/workspace@0.39.1
- @cotal-ai/lang@0.39.1

## 0.39.0

### Minor Changes

- 2277e28: A capability refusal is durable and retryable. A handler that cannot perform an effect on its host
  throws the new `EffectRefused`; the interpreter settles the entry with the new status `refused`
  under the handler's code (L5016 for the mesh handler's `NotYetDurable`, which now extends it) and
  unwinds the run with the uncatchable `RunHeld` (L5025). The driver grades the run `released`, and a
  resume on a capable host finds the new `refused` lookup verdict and performs the step live, so a
  run started before the durable-action surface lands heals the day it does. Previously the refusal
  settled `failed` and a resume replayed the failure forever.

  Two concurrent `turn`s on one agent handle are serialized at the dispatch seam both engines share:
  the second begins when the first settles, in dispatch order. Turns on different handles are
  unaffected.

  A fork's child records its lineage: the run record's spec gains `forkedFrom` (`{ run, step }`,
  absent on runs started fresh), `commitFork` writes it with the spec, and `ForkCommitResult.
lineageRecorded` is now true.

  Spec: §6.5 (turn serialization), §9.2 (six uncatchables), §10.1/§10.7 (the `refused` status and
  verdict), §11.1, §11.3, Appendix A (+L5025), and SPEC.md §14.3 (`forkedFrom`).

- 43e1f7d: Simulator fidelity, ask schema enforcement, journal result bound, and the scope release law.

  The simulator is now discrete-event: timed effects park at their wake times and are delivered in
  wake order on one virtual clock, so concurrent branches accumulate the durations they wrote and a
  simulated race is decided by the same rule as a live handler (least recorded clock, ties by
  declaration order) instead of by the order effects were asked.

  The reference simulator enforces the ask schema shorthand (spec §6.5): a schema it cannot read is
  refused with the new L4022 rather than skipped, a non-conforming reply consumes one attempt, and
  exhausted attempts report L4006.

  A journal can be constructed with a result bound (`JournalInit.resultBytes`, plumbed through
  `DriveRequest.resultBytes`); a settled ok result over it is refused ahead of the settling append
  with L5006, which leaves the reserved list.

  A host release or refused append inside a parallel, race, fanOut or conclave no longer cancels
  sibling branches or settles their in-flight entries cancelled: the unwind propagates bare, the
  scope settles nothing, and a resume picks the run up exactly where the journal says it stopped.
  The old behavior permanently poisoned any run a driver stopped while an effect was in flight
  inside a scope.

- 34ff272: `cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
  into the `cotal` binary: `start --file <program>` drives a new run on the mesh handler, `resume
<runId> --file <program>` takes an existing run over and drives it to quiescence, `ps` lists an
  endpoint's run records (state, holder, journal high-water, fork lineage), `journal <runId>` prints
  the durable step journal, and `answer <runId> <stepKey> --by <who> [--value <json>]` resolves an
  open checkpoint through the run driver, presenting as the arming holder read back from the
  checkpoint record (resume is holder-bound). One raw connection per invocation against the resolved
  mesh target; the journal's result bound is taken from the broker's own max_payload.

  `docs/workflows.md` gains an "Operating a run" section, the connector docs bundle carries it, and
  every connector folds a workflow steer (`WORKFLOW_STEER`) into its agent instructions beside the
  mesh-first steer, so agents reach for a durable journalled run instead of improvising long
  coordination loops in their own context.

### Patch Changes

- Updated dependencies [2277e28]
- Updated dependencies [43e1f7d]
  - @cotal-ai/lang@0.39.0
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- @cotal-ai/core@0.38.0
- @cotal-ai/lang@0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.

### Patch Changes

- Updated dependencies [e5e68ed]
- Updated dependencies [c31de91]
- Updated dependencies [d4779db]
- Updated dependencies [6926b34]
- Updated dependencies [d2c0fd3]
- Updated dependencies [7e45495]
- Updated dependencies [135ddaf]
- Updated dependencies [e703873]
- Updated dependencies [6c1cefe]
- Updated dependencies [00ac9d9]
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [0098000]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/lang@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/lang@0.36.0

## 0.35.0

### Patch Changes

- @cotal-ai/core@0.35.0
- @cotal-ai/lang@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/lang@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/lang@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/lang@0.33.8

## 0.33.7

### Patch Changes

- Updated dependencies [576ac7d]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/lang@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/lang@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/lang@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/lang@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/lang@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/lang@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/lang@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/lang@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/lang@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/lang@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/lang@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/lang@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/lang@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/lang@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1
- @cotal-ai/lang@0.29.1

## 0.29.0

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/lang@0.29.0

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/lang@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/lang@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [09b6a3b]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/lang@0.28.0

## 0.27.0

### Patch Changes

- @cotal-ai/core@0.27.0
- @cotal-ai/lang@0.27.0

## 0.26.0

### Patch Changes

- @cotal-ai/core@0.26.0
- @cotal-ai/lang@0.26.0

## 0.25.0

### Minor Changes

- 0471af2: The driver hosts the version-2 compiled engine: a fresh run is stamped language version 2 and executes on the engine in its own locked-down worker thread, while every version-1 record keeps replaying on the tree-walker and a record whose version the build does not serve keeps refusing by name (L5023). The engine gains a bridged handler route for hosts whose effect handler is a live object: the handler and the durable journal store stay in the host process, and the worker forwards the effect seam over a message port, so effects stay durable pending-before-effect and no socket or credential enters the isolate holding the program. Failures cross the thread boundary whole: an EffectError keeps its code, kind and detail, a release keeps its reason, and a lost journal is regraded as the class the driver's outcome contract names. A race loser's cancellation crosses the bridge and fires the host handler's signal while the effect is still in flight (a cancel aimed at an effect that already answered does not cross, which is the only time a handler could not act on one anyway). The driver also refuses a malformed run record by its own name: a `languageVersion` that is not a string is released as malformed before the engine table is consulted, instead of being misread as an unserved version. A stop check that throws inside the host's poll is re-raised as the run's fault on the caller's stack rather than escaping as an uncaught exception.
- dbeec0f: The language version belongs to the engine that runs a program, and a build declares which engines it hosts.

  There are two engines and now two versions: the tree-walker is language version `1` and stays the
  replay engine for every run recorded under it, and the compiled engine is version `2`, a different
  language rather than a faster one, since `log` is data there and refuses code, and a step is a
  transformed-site hit rather than a walker dispatch. `resolvePins` and `bindPins` take the version as
  an argument, so each engine stamps its own and compares against its own; `WALKER_LANGUAGE_VERSION`
  and `ENGINE_LANGUAGE_VERSION` are exported beside `LANGUAGE_VERSION`, which is an alias for the
  current language, the engine's.

  Bumping one shared constant was measured and is not available: the walker would stamp 2 and compare
  1, and every walker fresh-run-then-resume round trip fails. Leaving it at 1 while the engine speaks
  2 fails the other way, on records already written. Each engine stamping and comparing its own breaks
  neither.

  The run driver now holds a table of the versions this build hosts, ordered by declared precedence
  rather than by a string sort. A fresh run is stamped with the version of the engine that will
  actually execute it, and a record whose version no engine here serves is released by name with the new **L5023**,
  naming both the version it met and the set this build serves, with the run left untouched: nothing
  activated and nothing appended. It is released rather than failed or thrown, because a build that
  cannot host a language has observed nothing about the program.

  Migration: `resolvePins(options, now)` and `bindPins(recorded, options)` now require a third
  argument, the calling engine's version. Callers inside this repo pass their own; an external caller
  passes `WALKER_LANGUAGE_VERSION` to keep today's behaviour. Records do not cross between versions in
  either direction, which was already true and is now enforced by the engine that meets them.

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0471af2]
- Updated dependencies [dbeec0f]
- Updated dependencies [d3553be]
- Updated dependencies [dc34423]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [445e110]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/lang@0.25.0

## 0.24.0

### Minor Changes

- b7cc4fa: Host a cotal-lang run on the mesh.

  `@cotal-ai/lang` gains the durability the language rested on but did not have: run pins with a
  run clock, scope journal entries that record a race's winner and its losers so a replay resolves
  the same arm, a refusal when a resume is handed a journal without the pins that decide it, and an
  effect ceiling read from the pins rather than a default.

  `@cotal-ai/core` gains the step journal's storage plane, the run record and its lease, the
  checkpoint answer record, and the notice and migration records.

  `@cotal-ai/runtime` is new: the mesh handler that performs a program's effects on the real planes
  (durable pauses on the checkpoint plane, event awaits over durable consumers, notices), the
  `RunDriver` the manager daemon hosts, journal-replay resume, migration onto edited source, and a
  fork that redoes work under a new run id. Effects that need durable actions refuse through one
  named seam rather than pretending to succeed.

### Patch Changes

- Updated dependencies [9939dcc]
- Updated dependencies [b7cc4fa]
  - @cotal-ai/lang@0.24.0
  - @cotal-ai/core@0.24.0
