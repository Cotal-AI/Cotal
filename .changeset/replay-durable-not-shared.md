---
"@cotal-ai/core": patch
---

Stop a run's own replay durable from failing one of its steps

A branch of a `parallel` failed with `RunJournalReplayRaced` naming the run's own takeover consumer,
on a run with one activation, no second driver, and sibling branches that settled normally either
side of it. The message told the operator another driver was replaying the run and to retry the
takeover. There was no other driver.

The replay durable is named after the takeover, `wfj_<runId>_<takeoverId>`, and the name is unique
per takeover because a consumer name is one subject token that no grant pattern covers in part. What
is not one per takeover is the number of replays: a drive re-reads its journal at every effect and
at every poll of a parked pause, so one name is created and deleted hundreds of times over the life
of an attempt. Two things follow, and both were reachable.

A durable can be left behind. A replay is interrupted by whatever ends its connection, a standing
drive connection reconnecting under it or a host closing one on a parked drive, and the delete is
the part that does not land. Measured on a live broker: closing the connection 2ms into a
17-record replay left the durable at `delivered=17`, and the next replay on that takeover id then
read its own leftover as another driver's half-fed consumer. That is one fault reported to a
healthy run, since the refusing replay deletes the leftover on its way out and every replay after
it succeeds, which is the shape the report describes.

And two replays can share it. `RunScopeAuthority` serializes the reads it makes itself and nothing
serializes those against the driver's other readers on the same id: `activateRun`, the no-record
diagnostic, and a `RunHost.status` or `locate` handed the drive's lease id, all on the driver's
connection rather than the mediator's. Measured on a live broker at 17 records, eight replays fired
together on one id returned a torn fetch, `RunJournalReplayRaced`, and a silently EMPTY replay,
which reads back as a run with no history.

`replayRunJournal` now holds the two properties its own header claims. Replays on one durable run
one at a time in the process, keyed by the name rather than by any one caller, so a new caller
cannot forget to join. A durable of that name found holding a tail is removed and remade before the
read, because with the serialization in place it can only be this process's own leftover. The
freshness guard is unchanged and still refuses: if the remade consumer also comes back holding a
tail then a reader this process cannot account for is on the name, and reading its tail is the
thing the guard exists to prevent.
