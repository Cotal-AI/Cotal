---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Remote manager registration now holds a host-owned renewable lease so recovery cannot interrupt executor credential replacement.

Prepare, registration renewal and release share a durable compare-and-set lease. Recovery must claim an expired lease before changing a frozen registration, and a claimed or expired attempt cannot request fresh prepare authority. Upgrade the auth host and participant managers together.
