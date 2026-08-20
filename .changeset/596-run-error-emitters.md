---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
---

A failed turn is published as a run error, so a reader of an event plane can tell a turn that failed from a turn that finished.

Every connector used to close a run with `RUN_FINISHED` whichever way the turn ended, including a
turn its own harness had already classified as failed. `RUN_ERROR` was in the vocabulary, the
bracket machine accepted it as a close and the dashboard rendered it, but the shared close path had
no way to say it.

The close on the shared emitter and holder now takes an optional failure, and two connectors supply
one from a record they actually receive. Claude Code ends a failed turn on its own `StopFailure`
hook, and that turn now closes with `RUN_ERROR` carrying the harness's error kind (`rate_limit`,
`billing_error`, `server_error` and the rest) as the code. OpenCode reports a dead turn on
`session.error`, and that turn now closes with `RUN_ERROR` carrying OpenCode's own error name and
reason — except a turn a person stopped, which arrives on the same event and is not a failure.

Migration: nothing is removed and no existing call changes shape. A consumer that only handles
`RUN_FINISHED` now sees fewer of them on failing sessions; the event type it needs to also handle
has been part of the vocabulary and accepted by the bracket machine all along.
