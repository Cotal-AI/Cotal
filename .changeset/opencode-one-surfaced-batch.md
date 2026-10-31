---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-claude-code": patch
---

Share the OpenCode adapters' surfaced batch so a native prompt cannot replace the messages carried by an active turn. Queued messages remain pending and get their own turn after the active one ends. Update the Claude Code connector's comment naming that acknowledgment boundary.
