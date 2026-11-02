---
"@cotal-ai/core": minor
"@cotal-ai/seat": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/tmux": minor
"@cotal-ai/cmux": minor
"@cotal-ai/herdr": minor
"@cotal-ai/orca": minor
---

`cotal_spawn` takes `once: true` with a `prompt` to start a helper for one task. The manager relays the prompt to the helper as its only turn and stops the helper when that turn ends or when the deadline passes. The deadline is one hour unless `deadline` sets another, and `-1` sets none. A spawn that succeeds names the task's goal in its result, and `goal-result` reads how it ended. A task that ends without the helper ending its turn may have run in part or in full, and nothing runs it again. A once spawn needs no `run` capability.

The manager's `spawn` command takes `once: { deadlineMs }`, and the manager contract revision is 44. The task is served only after the spawn's succeeded terminal is written, so a manager that restarts before then cancels the task as never served. A seat hands a once task to its harness at most once. When it cannot confirm the harness took the task, it reports that with the new self-mode `turn-unconfirmed` command, which fails the task with `delivery-unconfirmed` and stops the seat. A manager that inherits a once seat it cannot hold ends the task without serving it, says so in the outcome, and answers that seat's every `turn-pending` with `stop` while its debt stays recorded.

A connector declares `supportsTurnRelay` to take a once task: Jcode, OpenCode, pi and Claude Code do. A connector whose seat needs a confirmed startup declares `onceNeedsConfirmed`, and the manager serves its task only when the runtime reports the startup watch ended `confirmed`. Claude Code needs it: a once launch waits for Claude's development-channels prompt and then its `confirmNotice`, the line saying `server:cotal` messages reach the session. A runtime declares `reportsStartupOutcome` and its handles report `startupOutcome()`; the built-in pty runtime, tmux, cmux, herdr and orca do. A connector may declare `turnFrameLimit`, and a once prompt whose task does not fit it is refused at admission. A once exit registered with `registerOnceExit` may answer false to decline, and the seat then keeps reporting instead of exiting. A connector whose seat launches processes outside its own implements `retireAfterExit`, and the manager keeps the task's debt until that hook proves them gone. Jcode records each native launch of a once seat under the seat's uid for that proof, and a Jcode once seat always starts a fresh session, never one an earlier seat of the same name left in its home.
