---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
---

A Claude Code session driven by hand without a control endpoint is now refused with a message that names `COTAL_CONTROL_SOCKET` and `COTAL_CONTROL_TOKEN`, and the configuration reference says a hand-driven Claude Code or jcode session sets both. The reference used to say `COTAL_CREDS` and `COTAL_SERVERS` were enough, and the refusal named neither variable.
