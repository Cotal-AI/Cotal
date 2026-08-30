---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
---

Connectors declare `supportsToolListAnnounce` (default-deny). A connection-changing op against a connector that cannot announce a tool-list change fails loud, without naming harnesses in shared code.
