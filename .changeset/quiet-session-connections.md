---
"@cotal-ai/auth": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

End a user-auth terminal session's broker connections without disconnecting the actor's other sessions or controls.

The auth host records private broker connection coordinates before releasing session access and reconciles terminal or removed session rows through the delivery service's verified eviction path. Failed reads and evictions retain the evidence for retry. Session connection expiry remains bound to the session grant.
