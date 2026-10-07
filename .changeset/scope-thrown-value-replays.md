---
"@cotal-ai/lang": patch
---

A value a program throws out of a concurrency scope now reaches `catch` as itself on resume, as it already did on the live run. The scope's `L4000` `scope-fault` record carries the value in a new `error.thrown` field, and a replay delivers that value instead of building the fault from the record. Before this, a `conclave` body that threw `"failure"` was caught as `"failure"` live and as `{ code: "L4000", kind: "scope-fault", message: "failure" }` on resume, on both engines, so a program that branched on the caught value diverged on the resume of unchanged source. The record carries a copy, and `catch` receives that copy deep-frozen like a scope's result, live and on resume, while the thrown value itself is not frozen. A resume refuses a loaded `error.thrown` with no canonical form (L5024). A thrown value with no canonical form, such as a function, cannot be recorded, so the scope delivers its fault record in its place on the live run too.
