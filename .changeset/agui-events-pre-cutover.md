---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
---

Rename the per-agent mirror channel to `events.<name>` and add the durable event-emitter foundations.

The persisted resume document moves to **version 2**. `launch.transcript` becomes `launch.events`, migrated at read time — a v1 document still resumes, and both polarities are preserved, so an agent preserved with the flag off comes back with it off. A document written by a newer build is refused with an operator-facing error naming the version and the remedy, rather than being partially read.

`multicastExpecting` gains a serialized-append fence proven across the whole expectation space, not only the first publish onto an empty subject. `JsonlFileSource` states the real bound of its consumed-prefix seal (the last 512 bytes, not the whole prefix) and refuses a symlinked source. `EventWal` lands as the emitter's durable state machine: publish never precedes the write-ahead record, success becomes durable before the frontier moves, and every corrupt, zero-byte or mixed-vintage document fails loud rather than being repaired.

Resuming an events-enabled agent now refuses when its preserved publish grant does not include the event channel, instead of launching it with a mute stream.

The write-ahead record now carries the frame's **body**, so a restart holding an unacknowledged frame can re-publish the same one — previously it recovered the id and the expectation that name a frame and nothing to send. `EventWal` also verifies the **space** it was opened under, alongside the principal and thread it already checked, and refuses two documents it used to accept: a nonzero frontier missing the source position it was derived from, and a `pending` key that is absent rather than explicitly null. Both were silent-loss paths — an absent cursor does not resume the durable source, it adopts at its current end.

The AG-UI event vocabulary lands as `connector-core/src/agui.ts`: the mapped event subset, their constructors, the frame envelope, and an incremental bracketing checker. The vocabulary is adopted; the SDK is not — `@ag-ui/core` is a `devDependency` pinned exact, imported for types only, so no zod copy reaches a bundled connector. Nothing emits yet; the connectors are untouched and still publish their existing mirrors.
