---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

Allow a spawn-scoped caller on a per-user-auth mesh to arm the event plane of a child under its own owner, including in spaces that require it. Cross-owner arming still needs admin authority, and event-channel and delegation-envelope restrictions are unchanged. Update the bundled event-plane authority documentation.
