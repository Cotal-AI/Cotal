---
"@cotal-ai/connector-claude-code": patch
---

The Claude Code AG-UI mapper's comments no longer restate its origin tables by hand. The module header listed `human` and `channel` as the only origins that open a run, while `ORIGIN_RULE` also opens `auto-continuation`; it now points to `ORIGIN_RULE` and `ABSENT_ORIGIN_RULE` as the only list. The `promptSource` field doc no longer says only `"sdk"` is read, and the run-opening comment no longer calls `channel` the only change from the plan's table. No behavior changes.
