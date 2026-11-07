---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/lang": patch
"@cotal-ai/seat": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
"@cotal-ai/web": patch
"@cotal-ai/linear": patch
"@cotal-ai/cmux": patch
"@cotal-ai/orca": patch
"@cotal-ai/tmux": patch
"@cotal-ai/herdr": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/pi": patch
"@cotal-ai/auth": patch
"@cotal-ai/registry": patch
---

A migration commit now ends the pause of a step the edited program no longer reaches, when that step is still pending.

The orphan row for a removed `sleep`, `wait`, `ask`, `checkpoint`, `turn` or `waitUntil` says nothing outlives it. `commitMigration` now claims that pause through the run handler's `endPause` before the migration record is filed, the same way a `--release` tears its seat down before the record says it did. A step that already settled ended its own pause, and a commit that would ignore a pending one of these but has no journal and no handler is refused before anything is written.
