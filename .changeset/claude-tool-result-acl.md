---
"@cotal-ai/connector-claude-code": minor
---

The Claude Code event plane no longer republishes tool-result bodies. A `tool_result` block has no
trusted provenance at the mapper, and `events.<owner>.<actor>` carries a different read ACL from
wherever the tool read, so `TOOL_CALL_RESULT` is suppressed rather than emitted with the body, an
empty string, or a placeholder. Call lifecycle (`TOOL_CALL_START` / `TOOL_CALL_ARGS` /
`TOOL_CALL_END`) is unchanged. Observers lose tool output they saw before; that is the intended
boundary, not a regression.
