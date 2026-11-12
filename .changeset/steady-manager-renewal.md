---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Keep manager requests flowing while its remote credentials renew. Bind the replacement serving connection before draining the old one, and use incarnation-scoped queues to prevent duplicate execution without widening permissions. Wait for outgoing supervisor, goal and session-ledger requests before reconnecting those duties. Bound retired serving drainage and report unfinished requests without retrying their effects. Retry serving issuance after an unchanged-authority gate touch so concurrent session mints do not cause renewal refusals.
