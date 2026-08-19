---
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Codex seats publish an AG-UI event plane

A Codex seat launched with `cotal spawn --events` now publishes a structured account of its work on
`events.<owner>.<actor>`: run boundaries per turn, assistant text, reasoning summaries, and the tool
calls the model makes through Codex's function-call and custom-tool interfaces, each with its
arguments, its end, and its result. Before this the connector had no event plane at all, so an
external observer watching a mesh saw nothing from a Codex seat.

The durable source is the thread's rollout file inside the seat's own isolated `CODEX_HOME`, not the
live app-server stream. The file is written by the child and outlives this process's view of it, so a
seat that restarts its own app-server picks a thread's records up where it stopped rather than from
whatever the socket delivers next.

Four behaviours are worth knowing before reading a stream. A turn that fails ends its run with a run
error carrying the code Codex reported, rather than as a finished run, because Codex records a
failure on the turn's own completion record. No user authored text is ever published: your prompts,
the peer messages injected into the thread, and the persona's developer instructions are all
withheld, because the events channel carries a different read ACL from the channel you typed into.
A restarted app-server is a new thread and gets a new stream: the seat finishes the old one, closing
any run it left open, before it begins the new one. That holds even when the new thread's file is
slow to appear, which is the case where the old one is closed and the seat then waits, publishing
nothing, rather than continuing to report the dead thread's activity as if it were live. And Codex's own built-in tools, web search, tool
search and image generation, are not published, because their records carry an end with no start and
no key that joins the halves.

What is published is worth stating plainly: an observer of the events channel sees every tool call's
arguments and outputs verbatim, so withholding user authored text does not make the stream safe to
widen.

Two limits are worth knowing as well. A stream begins at the last complete record in the file at the
moment the seat binds to it, never at the beginning of the thread, so anything written before that
moment is not republished; the seat says so in its log when it happens. And a seat whose broker was
unreachable when it started loses its emitter, reports that it did, and rebuilds it at a later turn
boundary once the broker is there, so the outage costs the turns it covered rather than the rest of
the seat's life.

Migration: none. The plane is opt in per spawn, arming is separate from authorization, and a seat
launched without `--events` behaves exactly as before.
