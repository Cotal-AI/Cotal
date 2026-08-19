---
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-core": minor
---

Codex event plane: take the stream's starting boundary at the bind, not when the emitter finished starting

An armed Codex seat announced its stream as started at the bind, then positioned itself wherever the
rollout file happened to be once its asynchronous setup had finished: the write-ahead log directory,
the subject frontier, the log open, then a channel resolve and a preflight. Every record the thread
appended inside that window landed behind the cursor and was treated as already published, so a turn
that completed inside it was dropped permanently and silently, underneath a line that had already
said the stream was live. The boundary is now captured at the bind, before the announcement, and
substituted on the emitter's first read, so the announced fact is true at the moment it is
announced. A log that already carries a cursor is a resume and keeps it, because a cursor written by
a live emitter is the honest one.

It is substituted rather than written into the log, and that half is what keeps a failed start from
changing what a later one publishes. A seat whose broker is not up yet loses its emitter at launch;
a boundary written into the log before that start would outlive it, and the next bind would read it
as a resume and republish everything the thread wrote while the seat was cut off, onto an events
channel whose read ACL is not the input channel's. The log's cursor is now written only by an
emitter that started.

Migration: a rebind after a lost connection declines to publish two things, and readers who watched
the old behaviour should expect both. It declines what the thread wrote during the outage. It also
declines the turn whose own boundary triggered it, because Codex writes a turn's first record before
it announces that the turn started, that announcement is what a rebind runs on, and a run is never
opened from the middle of a turn. The first turn to start after the rebind is published in full.
One case is different: if the emitter had already been publishing this thread and then died, its
position is in the log, and the rebind continues that log rather than starting where it binds,
delivering what the dead emitter had read but not yet sent. Nothing is sent twice in either case. A
seat launched without the event plane armed is unaffected.
