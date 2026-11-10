---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Report daemon service credentials that have expired by the local clock as a credential-time conflict instead of an unreachable space. Preserve the renewal source's failure classification and advise checking clock synchronization without accepting expired credentials or changing request IDs.
