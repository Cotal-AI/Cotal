---
"@cotal-ai/lang": minor
"@cotal-ai/core": minor
"@cotal-ai/runtime": minor
---

A capability refusal is durable and retryable. A handler that cannot perform an effect on its host
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
