---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Participant managers now resume large startup registrations after the five-minute executor expires and report revocation counts.

Fresh prepare authority keeps the same account, lifecycle and executor identity while the existing frozen operation preserves completed revocations and verified-holder progress. Non-expiry failures and refused host requests still stop startup, including eviction or reconciliation failures that overlap executor expiry.
