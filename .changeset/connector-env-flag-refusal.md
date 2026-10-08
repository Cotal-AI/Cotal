---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

The connector on/off flags `COTAL_CHANNEL`, `COTAL_EVENTS`, `COTAL_EVENTS_REQUIRED`, `COTAL_CODEX_TUI` and `COTAL_JCODE_TUI` now share one parser in `@cotal-ai/connector-core`. It accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` in any case, treats an unset or blank value as unset, and refuses anything else at startup with an error naming the variable and the value. Before, each connector kept its own copy and read any other value, such as `enabled`, `2` or `y`, as off without a word. The OpenCode 2.x adapter now refuses `COTAL_EVENTS=true` the same way it refuses `COTAL_EVENTS=1`, where before only `1` was refused.
