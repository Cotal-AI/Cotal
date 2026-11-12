---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/workspace": patch
---

Reduce active broker resources for channel-less agents and derived membership. The membership feed is now Memory-backed with explicit privileged legacy conversion, while empty channel read ACLs omit the DLV durable and its bind grants without changing DM or File-backed lease state. Chat adapters pass the resolved read ACL, chat admission reads back only provisioned durables, and an unexpected denied bind still refuses startup.
