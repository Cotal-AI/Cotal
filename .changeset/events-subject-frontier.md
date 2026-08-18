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
mesh with user authentication the agent name is the actor, and a restart forks the session id, so the
first restart of any managed agent was enough to take its event stream dark. Reproduced against a
real broker across three sessions, and it did not recover on its own.

Alongside the per-session logs the connector now keeps one record per principal, holding the last
sequence the broker assigned on that channel, so a new session continues the stream instead of
starting again from nothing. An installation upgrading from a release without that record recovers
the sequence from the session logs already on disk, so the fix applies to agents that have already
run rather than only to ones starting fresh. An abandonment after a channel purge clears the record
with the logs, and a record that reads zero is never re-seeded, because that is what abandonment
writes.

The halt message previously offered three causes, another writer, a restored stream, or a filtered
purge, and the real one was not among them, so an operator went looking for a rogue writer. It now
names what a moved tip can actually mean, including a concurrent session under the same principal and
a frontier record that disagrees with the stream. It also states the limit of the per-principal lock
rather than claiming the lock prevents the case the halt fires on, since that lock excludes a second
emitter only within one workspace root on one host. And where it used to name an abandonment as the
remedy, it now says no command performs one, names the directory that has to go, and says removing
less leaves a mixed state the next start refuses.

The scan that recovers a tip from the session logs refuses a symlinked entry and opens each log
without following links, matching the directory chain that creates this state and already refused a
symlinked component. Without that, a link planted where a session directory belongs took the scan to
a log in another tree.

MIGRATION: `AguiEmitter.start` now requires a `subjectFrontier`, and refuses at runtime without one
rather than falling back to the per-session number, because that fallback is the defect. Anyone
embedding the emitter directly must open a `FileSubjectFrontier` at the `subjectPath` that
`ensureEventWalDir` now returns and pass it. Connectors in this repository are updated. No wire bytes
move and no grant changes: the channel grammar is unchanged.
