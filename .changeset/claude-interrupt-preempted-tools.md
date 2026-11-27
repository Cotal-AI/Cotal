---
"@cotal-ai/connector-claude-code": patch
---

Stop foreground tools that a remote `interrupt` moved to the background when a prompt sent mid-turn stayed queued in Claude Code until `interrupt` aborted the turn and was appended after the abort's tool result before `interrupt` read the session messages.
