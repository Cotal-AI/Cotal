# @cotal-ai/runtime

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
