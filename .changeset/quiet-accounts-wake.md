---
"@cotal-ai/core": patch
---

Hosts can hibernate inactive data and auth-callout accounts on a full-resolver broker, then wake them without changing account identity or authority. The stock claim helpers preserve signing keys and per-user revocations, distinguish hibernation from retirement, and reject invalid transition templates.
