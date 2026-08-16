---
"@cotal-ai/runtime": minor
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
---

Add the run driver: the one process that holds a run, drives it to quiescence over the activation
barrier, and stops the moment it is no longer that process. Start and resume are the same act with
one bit of difference, and the caller states which — a run's journal cannot say whether an empty
subject means "never started" or "retired by purge", so `startRun` and `driveRun` say it instead and
the barrier refuses the mismatch either way. Losing a run comes back as an answer rather than an
exception: a driver that no longer holds one has driven nothing, and reporting that as a run outcome
would be recording a conclusion about work it never saw.

A host can now stop a run between effects without failing it. A driver holds a run under an absolute
work horizon and can be asked to hand it back; neither is a fact about the workflow, so neither may
be recorded as its outcome. `RunOptions.shouldStop` is asked before every effect that is not already
recorded — nothing begun, no handler dispatched — so the run stays exactly where its journal says it
is and the next driver resumes from there. The interpreter raises `RunReleased` (L5012) itself
rather than accepting an error from the caller, and a workflow's `catch` cannot see it, for the same
reason it cannot see a cancellation or a refused append.

In core, the run driver's journal credential is now minted for ONE takeover. The replay consumer's
grant carried `wfj_<runId>_*`, which reads like a pattern and is not one: NATS expands `*` as a whole
subject token only, so the row was a literal matching no consumer a driver would create, and under a
broker that enforces its permissions no run could be replayed at all. The takeover id belongs to the
credential, minted with the lease. Alongside it: the takeover a barrier authorizes is now the exact
takeover it publishes, the replay hook observes the validated prefix without holding it, an equal
fencing token is bound to one holder at one epoch, and the boundary between "the stream refused this
append" and "this process could not serialize it" is the wire — a record that never left the process
leaves the run untouched.
