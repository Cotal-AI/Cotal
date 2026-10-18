---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Every place that decides whether a write lost its expected-last-sequence CAS now calls `isCasLoss`, which reads the JetStream error code (10071 or 10164) and never the message text. The `deprovisionAgent` purge path used to accept 10071 or any message containing "10071" or "wrong last sequence", and missed 10164. The auth session ledger kept its own copy that read an `api_error` field the JetStream client does not set, so it only worked through a message match. The create-only publishes for goal binds, work items, checkpoint settle facts, receipts and contract artifacts spelled the code pair inline.
