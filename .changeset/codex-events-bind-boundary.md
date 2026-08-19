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
One case is different and is stated in full rather than in passing, because it is the one a reader
is most likely to be surprised by: if the emitter had already been publishing this thread and then
died, its position is in the log, and the rebind continues that log rather than starting where it
binds. An outage there costs the wait, not the content: what the thread wrote while the plane was
down, and what it wrote while the plane was already dead, is delivered once the plane is back. Two
things follow that a reader should not have to discover. A tool result is published as the tool
returned it, so text a tool read on the seat's behalf from a channel with a narrower reader set
crosses into the events channel unredacted and unattributed; and a backlog written while the plane
was terminal is delivered rather than discarded. The session's own record of the user's words and
the developer instructions is not published in either case. Neither carrier is introduced here and
neither changes shape; both are the same at the merge base and no new shape is added. What this
change does alter, on every armed seat and not only the one whose emitter never started, is which
records reach the stream: what the thread appended between the bind and the emitter's first read
used to land behind the cursor and be dropped, and it is published now. A whole turn can sit in
that window, tool results included, so the carrier above covers a stretch of the session it
previously lost. The reader set that follows from all this is a requirement and not a guarantee:
the grant does not enforce it. A spawn gives a seat permission to publish its own event channel and
nothing else and is refused if it names another agent's, and read access is minted separately and
out of band, so holding the events readers to at least the width of every channel the seat's tools
can read is the operator's policy to keep. Nothing is sent twice in either case. A seat launched
without the event plane armed is unaffected.

The window above is now graded rather than argued. A test-only setting widens the emitter's setup
so a fixture can release a whole completed turn into it and assert the turn reaches the wire;
absent, empty, zero, negative and unparseable all mean no wait, so an uninstrumented seat runs the
path it ran before. Measured, and the reason the cell was needed: the mutant that deletes the
boundary rule passed the suite three times in five without it, failing on disjoint cells the two
times it failed.
