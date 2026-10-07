---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The run admission and run attempt requests from a registered manager now refuse a `requestId` outside the 22-64 character idempotency token grammar and an `actor` that is not an owner token, as the other registered-manager requests already did. The manager-service authority request also refuses such an `actor`. Core exports `parseRemoteManagerEnvelope`, the one parser for the fields every registered-manager request carries, and the auth parsers call it in place of their own copies.
