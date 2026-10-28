---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

A managed seat on a legacy-rail bearer no longer asks the broker for its accepted row on every manager call. The read is attempted once per credential and rechecked hourly; a refusal is remembered, so a seat that pulls its turns every 15 s stops putting one refused `DIRECT.GET` request in the broker's log each time (100k to 340k lines a day on one hosted mesh). Issued views are unaffected: their read succeeds and nothing is remembered. `managerCallerBinding` now also returns the bearer's `credentialId` when the issuer stamped one.
