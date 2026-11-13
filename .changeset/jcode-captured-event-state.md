---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

Jcode agent cards now report their enabled event plane after launch settings are removed from the private process environment. The host passes its captured armed state through connector-owned options, while required events remain enabled and agent-file metadata cannot override it.
