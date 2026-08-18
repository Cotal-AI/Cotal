---
"@cotal-ai/connector-core": minor
---

SPEC v0.5: workflow runs, and the normative language reference.

`SPEC.md` gains the v0.5 binding revision: a §14 "Workflow runs" that defines a run's wire footprint
(the `run` record with its resolved pin set, the `WFJ_<space>` step-journal
stream with one subject per run and its replay-then-activate barrier, the `answer`, `notice` and
`migration` record kinds with their derived ids, the per-run driver grants, and a conformance list),
the four kinds in the §13.7 table, the stream in §13.12, and the change-log, reference-map and
normative-reference rows. `spec/cotal-lang.md` is the new normative reference for the workflow
language: syntax table, values and the boundary rule, the library, the effect primitives with their
hashed projections, the concurrency scopes and the clock-decided race, determinism (time, randomness,
pins, language version), errors, the step journal's entry schema, key grammar, digest and request id,
resume, migrate and fork, and the error catalog. Every `js` block in it is validated by the language's
surface suite. `docs/workflows.md` is the guide, and `cotal_docs` serves the reference offline as page
`lang` (also `cotal-lang`), indexed for search beside the spec. This is the contract, ahead of the
hosting: on the mesh handler `spawn`, `turn`, `ask`, `monitor`, `wait(replied)`, `wait(down)` and
`conclave` still refuse with L5016, and no `cotal` command starts a run yet; a program runs
in-process through `@cotal-ai/lang` today, as the guide says.
