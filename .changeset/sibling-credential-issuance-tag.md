---
"@cotal-ai/core": patch
---

A manager restart whose activation lands in the same second as an earlier goal-writer or session-ledger issuance no longer fails with `conflict` and `FOREIGN content` on its `epcred.manager.<instanceId>` row. Those two credentials now carry a random `issuance:` tag, so every mint signs distinct bytes and gets its own ledger row instead of re-signing the credential the restart barrier just revoked.
