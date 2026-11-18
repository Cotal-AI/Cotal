---
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
"cotal-ai": patch
---

Simultaneous local MCP connections now receive distinct names.
Local conversation provisioning reserves each name in the shared Cotal home before presence appears, including when hosts use different temporary directories, so the other host receives the next numbered name and direct messages remain unambiguous.
