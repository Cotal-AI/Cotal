---
"@cotal-ai/core": patch
---

Describe retry (and the same no-throw callback shape on follow-goal and scatter) formats an arbitrary caught value without throwing, so a poisoned `message` getter or `toString` cannot escape the timer. The pending describe still settles as unavailable.
