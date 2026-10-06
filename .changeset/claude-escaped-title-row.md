---
"@cotal-ai/connector-claude-code": patch
---

The Claude connector now finds a session's `/rename` title when the transcript row spells its type with a JSON escape, such as `"custom\u002dtitle"`. Before, such a row was skipped: a detached `--resume <name>` naming that title went to the manager host as an id instead of being refused, the carried title was missing, and a later rename written that way lost to an earlier one. Every transcript line is now parsed before its type is read.
