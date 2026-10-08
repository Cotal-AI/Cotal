---
"@cotal-ai/runtime": patch
---

Fix a hosted `checkpoint` with `onExpiry: "escalate"` failing L4000 every time its first attempt expired. The escalated attempt read the first attempt's binding as its own, so it armed at the first attempt's already-passed deadline and never recorded its own. Each attempt now binds its index with its deadline: the escalation opens with a fresh `timeout`, records its addressee and deadline, and a resumed attempt keeps the deadline it recorded.
