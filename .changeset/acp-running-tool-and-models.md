---
"@cotal-ai/acp": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

In ACP clients such as T3 Code, a Claude Code tool call now shows while the tool runs, and the model list no longer offers an application it cannot start.

- Claude Code: a tool call shows within about a second of its start while the tool runs.
- `cotal acp`: lists an application's default model once when its catalog also has a model named `default`, with that model's name and reasoning choices.
- `cotal acp`: refuses an application whose models the manager could not read, with the manager's reason, in place of offering its default alone. Loading or opening a thread on a running agent of that application still works.
- Claude Code, OpenCode 2.x and pi: a model catalog read that fails, or that lists no model a seat could run, such as a logged-out Claude Code or a pi without provider credentials, now fails. `cotal models` reports that catalog as unreadable, exiting 4, or 5 with `--harness`, and `cotal acp` leaves the application out with the reason.
