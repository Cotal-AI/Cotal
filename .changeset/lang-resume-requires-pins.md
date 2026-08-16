---
"@cotal-ai/lang": minor
---

A resume over a recorded journal must now carry the run's pins, and is refused (L5021) rather than
silently re-resolving them.

The pins were optional on every call, including one that was handed history. A caller that passed a
journal and omitted them did not fail anywhere: the epoch was re-read from the resuming host's clock
and the seed fell back to the interpreter's default, and the run carried on as a different run
reading the same journal. Nothing could refuse it downstream, because neither the clock nor a pure
draw is a recorded fact for the replay to compare against.

Measured on a journal recorded at epoch `1000000000000` and resumed a day later without pins:
`now()` before the first effect returned the RESUMING host's clock, the run clock stayed on that
host's time even after a replayed `sleep` whose recorded `endedAt` was `1000000001000`, and a run
pinned to a deliberate seed drew `0.5057680` where the recording drew `0.6367686`. A program that
branches on elapsed time or on a pure draw therefore took a branch decided by when someone happened
to restart it.

The refusal reads the journal's ENTRIES, not the option: a run handed an EMPTY journal is a fresh
run being given its store, which is how a driver ordinarily supplies one, and that still works.
Every production caller already passed pins — the run driver reads them from the run record and the
migration walk takes them from the request — so this makes the contract the code's rather than the
caller's memory.
