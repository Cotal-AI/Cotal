---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

MCP hosts connecting at the same time now receive distinct names on local spaces.
Local conversation provisioning reserves each name under a shared lock before the host publishes presence, and releases it when the identity is retired.
