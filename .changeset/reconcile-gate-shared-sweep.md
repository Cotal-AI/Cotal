---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Gate reconciliation no longer scales with credential family size. `cotal reconcile-gate`, manager boot self-heal and remote manager maintenance revoke the family's ledger rows 16 at a time, then verify-evict every distinct holder in one shared scan, KICK and verify sweep through the new `evictPrincipals` delivery-admin verb instead of one connection and one sweep per holder. Holders a sweep verifies are still recorded durably when another holder is not verified, and an interrupted sweep records none.
