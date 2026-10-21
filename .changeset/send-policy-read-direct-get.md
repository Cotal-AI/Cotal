---
"@cotal-ai/cli": patch
---

A channel `cotal send` on a static or open mesh no longer leaves a channel-registry consumer on the broker for five minutes. Its channel-policy read now uses one Direct Get, as the transient endpoint and `cotal channel` already do. A user-auth send keeps its scan, because a user bearer has no Direct Get row.
