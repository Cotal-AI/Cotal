---
"@cotal-ai/auth": patch
---

Refuse a hosted auth start when the stored and legacy instance identities have different public serve keys, even if their instance ids and seeds agree. Preserve both records on that refusal.
