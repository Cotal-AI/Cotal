---
"@cotal-ai/auth": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

End a user-auth terminal session's broker connections without disconnecting the actor's other sessions or controls.

The auth host records authenticated broker connection coordinates and an observed session revision before releasing session access. It refuses unsigned or altered evidence, retains receipts while session authority is unreadable, and retries transient failures with capped backoff. Exact eviction requires the executor to acknowledge the received connection filter. Purge markers use a constant one-hour TTL. The session sweep stops and drains its current broker call during shutdown. Session connection expiry remains bound to the session grant.
