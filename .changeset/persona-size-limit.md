---
"@cotal-ai/cli": patch
---

`persona create`, `personas new` and `persona edit` now refuse a persona definition over 1 MiB with
`SCHEMA_INVALID`, the bound `persona create --on` already applies to its input. An edit keeps the
oversized draft and names it. A 2 MiB persona used to be saved with no warning.
