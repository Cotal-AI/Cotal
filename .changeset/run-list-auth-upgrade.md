---
"@cotal-ai/runtime": patch
---

Run listing now names the missing auth-service grant and tells the space operator how to restore it. Managers from 0.149.0 require the space's auth service to be upgraded to 0.149.0 or later first, because it issues the batched records-read grant. A denial of that grant returns failed-precondition without falling back to per-run reads. After upgrading the auth service, retry the list to obtain a fresh per-call credential.
