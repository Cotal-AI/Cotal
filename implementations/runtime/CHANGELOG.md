# @cotal-ai/runtime

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
