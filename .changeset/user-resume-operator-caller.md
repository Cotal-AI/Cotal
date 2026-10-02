---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Resume a preserved user-auth mesh as the logged-in operator. `cotal up` after `down --preserve-state` used a static instrument whose caller has no ledger row, so the manager refused `resume-preserved` for want of `admin` and the maintenance journal degraded. The resume now uses the operator's manager view, the same caller the preserve cut used.
