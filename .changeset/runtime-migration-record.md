---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A run's move onto edited source is now durable: a `migration` record kind, and a commit that files it.

A migration is append-only history with an actor on it, and a run can migrate more than once, so it
does not fit either half of the run record — the spec is what a run IS, decided once, and the status
is what it is DOING, rewritten by every driver heartbeat. It gets its own kind, keyed by an id
derived from the report's own content so the retry a crash forces lands on the same record rather
than filing a second migration for one decision. Deciding and applying are separate: the spec is the
report, the status is which driver actually advanced the run, decided by a create-only CAS so two
drivers racing cannot both believe they moved it — while a driver that finds its own application is
looking at its own earlier attempt, which is a retry and not a race.

Committing an inadmissible report is refused before anything is written. The run's pinned program
hash still does not advance, because the run record carries none to advance; the migration is durable
and readable, and that gap is stated rather than papered over.

`programHashOf` is now the single definition of a program's identity, so the hash a run is pinned to
and the hash a migration records are the same function's answer.
