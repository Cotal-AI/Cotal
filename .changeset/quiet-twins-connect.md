---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Concurrent MCP-only hosts using the same local account now receive distinct agent names.
Local identity provisioning reserves each name before presence starts and keeps it reserved until retirement, so the next host can report the next free suffix and name-based messages remain unambiguous.
