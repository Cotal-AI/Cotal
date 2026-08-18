---
"@cotal-ai/connector-codex": minor
"cotal-ai": minor
---

Codex seats publish an AG-UI event plane

A Codex seat launched with `cotal spawn --events` now publishes a structured account of its work on
`events.<owner>.<actor>`: run boundaries per turn, assistant text, reasoning summaries, and each tool
call with its arguments, its end, and its result. Before this the connector had no event plane at
all, so an external observer watching a mesh saw nothing from a Codex seat.

The durable source is the thread's rollout file inside the seat's own isolated `CODEX_HOME`, not the
live app-server stream. That choice is what lets a restarted seat continue a thread's event stream
where it stopped rather than reopening it, which a live stream cannot do.

Two behaviours are worth knowing before reading a stream. A turn that fails ends its run with a run
error carrying the code Codex reported, rather than as a finished run, because Codex records a
failure on the turn's own completion record and writes no separate error record. And no user
authored text is ever published: your prompts, the peer messages injected into the thread, and the
persona's developer instructions are all withheld, because the events channel carries a different
read ACL from the channel you typed into.

Migration: none. The plane is opt in per spawn, arming is separate from authorization, and a seat
launched without `--events` behaves exactly as before.
