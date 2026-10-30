---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/connector-claude-code": minor
---

`cotal_spawn` takes `once: true` with a `prompt` to start a helper for one task. The manager relays the prompt to the helper as its only turn and stops the helper when that turn ends or when the deadline passes. The deadline is one hour unless `deadline` sets another, and `-1` sets none. The spawn result names the task's goal, and `goal-result` reads how it ended. A task that ends without the helper ending its turn may have run in part or in full, and nothing runs it again. A once spawn needs no `run` capability.

The manager's `spawn` command takes `once: { deadlineMs }`, and the manager contract revision is 44. A seat hands a once task to its harness at most once. When it cannot confirm the harness took the task, it reports that with the new self-mode `turn-unconfirmed` command, which fails the task with `delivery-unconfirmed` and stops the seat. A connector declares `supportsTurnRelay` to take a once task: Jcode, OpenCode and pi do, and Claude Code refuses with its `turnRelayRefusal`. A connector whose seat launches processes outside its own implements `retireAfterExit`, and the manager keeps the task's debt until that hook proves them gone. Jcode records each native launch of a once seat under the seat's uid for that proof.
