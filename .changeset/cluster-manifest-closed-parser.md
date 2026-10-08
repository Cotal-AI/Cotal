---
"@cotal-ai/core": patch
---

`verifyClusterManifest` now parses the closure manifest with the same closed parser the contract store uses for `publishContractClosureManifest` and `fetchContractClosure`. A manifest that carries a field beyond `v`, `root` and `members` no longer verifies under its own closure digest at registration, serve authorization, trait value-schema reads or the auth plane's manager surface read; it refuses with `contract-invalid` naming the field, so one root document never verifies under two closure digests. Other manifest refusals keep the `contract-invalid` code and now use the store's wording.
