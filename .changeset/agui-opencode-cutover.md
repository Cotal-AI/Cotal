---
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-core": minor
---

OpenCode sessions publish AG-UI events, so a seat's work is readable by a program rather than only by a person.

A session spawned with `--events` now publishes run boundaries, assistant text, reasoning and every
tool call with its arguments, its end and its result, on `events.<owner>.<actor>`. Until now only
Claude Code did; an OpenCode seat's event panel was empty.

Migration: nothing is removed and no behaviour changes for a session that does not ask for events.
A personal `opencode` with the plugin installed still publishes nothing, because arming is
`COTAL_EVENTS` and the launcher sets it only for a `--events` spawn.

Two limits are deliberate and documented. No user-authored text is published: OpenCode injects a
peer batch by prepending it into the human's own text part, so one record holds both authors with no
boundary in it to filter on, and guessing where one ends would fail open the moment either formatter
changed. And no step events or usage numbers: OpenCode's step records carry no step name and no key
shared between start and finish, and what the finish carries is cost and tokens, so emitting a step
boundary would tell a reader that a phase ended when what happened is that counts arrived.

The reader is the same on every connector, so the channel, the grant and how to subscribe are
documented once in the Claude Code page and linked from the OpenCode one.

`@cotal-ai/connector-core` is listed because the generated documentation bundle it carries is
regenerated with the pages.
