---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Preserve native admission CAS conflicts as `conflict` rather than `permission-denied`. Add a real concurrent two-instance regression that verifies one winner, no loser effect, and no automatic admission retry.
