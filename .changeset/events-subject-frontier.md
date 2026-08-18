---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"cotal-ai": minor
---

events: an agent's second session publishes again, and the halt names the causes that can actually produce it

Only an agent's first session ever published AG-UI events. Every session after it halted the emitter
permanently. The write-ahead log is keyed per session and the event channel is keyed per principal,
so a new session opened with an expectation that its channel was empty, while its own previous
session had already filled it. The broker refused the publish and the emitter stopped for good. On a
mesh with user authentication the agent name is the actor, and a restart forks the session id, so
the first restart of any agent spawned with the event plane armed was enough to take its event
stream dark. An agent on a static credential is reached the same way through preserve and resume,
which relaunches the recorded identity while the session under it is new. Reproduced against a real
broker across three sessions, and it did not recover on its own.

Alongside the per-session logs the connector now keeps one record per principal, holding the last
sequence the broker assigned on that channel, so a new session continues the stream instead of
starting again from nothing. An installation upgrading from a release without that record recovers
the sequence from the session logs already on disk, so the fix applies to agents that have already
run rather than only to ones starting fresh. That recovery reads the sequence a log took an
acknowledgement for but did not fold, which is where the real number sits when a session died in
that window, and it refuses a log it cannot account for rather than taking the largest number it can
find. An abandonment after a channel purge clears the record with the logs, and a record that reads
zero is never re-seeded, because that is what abandonment writes.

The halt message previously offered three causes, another writer, a restored stream, or a filtered
purge, and the real one was not among them, so an operator went looking for a rogue writer. It now
names what a moved tip can actually mean, including a concurrent session under the same principal
and a frontier record that disagrees with the stream. It also names the one cause that is not
another writer at all: a crash between the shared record's advance and the log's own record of the
ack leaves the record ahead of the expectation the log is still holding, so the retry publishes a
sequence the subject has already passed and the halt looks exactly like a foreign write. The
message says what that state looks like on disk. It also states the real gap in the per-principal
lock rather than claiming the lock prevents the case the halt fires on: the lock file lives under a
workspace root, so a second emitter started against a different root meets no lock, while another
host or a stale pid refuse the start instead of slipping past. And where it used to name an
abandonment as the remedy, it now says no command performs one, names the directory that has to go,
and says removing less leaves a mixed state the next start refuses. Clearing that state is valid
only once the channel itself is back to empty, which of the causes above is true of a filtered
purge alone; on any other cause the tip stays where it is, so removing the directory returns the
same halt with the logs a tip could have been rebuilt from now gone, and the channel purge is the
half that comes first.

The scan that recovers a tip from the session logs refuses a linked entry and refuses a linked log,
matching the directory chain that creates this state and already refused a symlinked component.
Without that, a link planted where a session directory belongs took the scan to a log in another
tree. What it does not close is a session directory swapped for a link in the moment between the
check and the open: the non-following open flag covers the final name only, and closing that window
would take a per-component walk the scan does not do. A log reachable under more than one name is
refused too, and the ordinary way to produce one is copying a workspace with hard links, which makes
the recovery refuse every log rather than half-trust them.

The record itself is now graded on the file rather than on the writer's view of it. A second view of
one record could take the tip backwards with no error at all, because the comparison was against
memory while the rule was written about the value on disk. Nothing shipped reaches that today, and
that is measured rather than assumed: a stale view publishes a stale expectation and the broker
refuses it before an acknowledgement exists to record. It is guarded anyway, because an assumption
recorded in prose where a guard belongs is what produced this defect in the first place. A record
that goes corrupt underneath a live writer is now refused before the write instead of being
overwritten, and an abandonment refuses outright when it cannot reach the shared record, rather than
clearing the log's half and reporting a completed abandonment.

MIGRATION: `AguiEmitter.start` now requires a `subjectFrontier`, and refuses at runtime without one
rather than falling back to the per-session number, because that fallback is the defect. `EventWal`
refuses the same way: a log with no record bound has no publish expectation and says so instead of
offering its own last acknowledged sequence, and an abandonment on an unbound log now refuses rather
than clearing half of the state, so anyone driving a log outside the emitter must bind one first.
Anyone embedding the emitter directly must open a `FileSubjectFrontier` at the `subjectPath` that
`ensureEventWalDir` now returns and pass it. Connectors in this repository are updated. No wire
bytes move and no grant changes: the channel grammar is unchanged.
