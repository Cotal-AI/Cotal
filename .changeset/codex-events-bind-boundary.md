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
seeded into the write-ahead log when that log is fresh, so the announced fact is true at the moment
it is announced. An existing log keeps its own cursor, because that is a resume and its cursor is the
honest one.

Migration, and a behaviour flip the docs previously described the other way round: when a seat's
broker is unreachable at launch and the plane rebinds at a later turn boundary, the turn that
triggered that rebind is now published. It used to be dropped. The rebind is taken at the start of
that turn, before the turn's records exist, so the turn is ahead of the boundary rather than behind
it, and this is a first publication rather than a repeat, because the emitter that died had
published nothing at all. Records written during the outage itself are still not republished, and a
seat launched without the event plane armed is unaffected.
