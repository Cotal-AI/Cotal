---
"@cotal-ai/connector-codex": minor
---

A Codex agent's skills can now be listed and run from its owner's session, the way OpenCode 2.x commands and skills already can. The Codex host gives its `agent` endpoint a command dispatcher: `commands` lists the enabled skills Codex's `skills/list` finds, `command` starts one as a skill turn through `turn/start` with the listed path, and `interrupt` stops the running turn with `turn/interrupt`. An unknown or disabled skill is refused as `not-found`. Codex's app-server has no way to list or run its built-in slash commands or custom prompts, so those are not offered.
