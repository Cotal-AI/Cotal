---
"@cotal-ai/auth": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

End a user-auth terminal session's broker connections without disconnecting the actor's other sessions or controls.

The auth host records authenticated broker connection coordinates and a verified session revision before releasing session access. It refuses unsigned or altered evidence, quarantines invalid records without blocking later work, and retries transient failures with capped backoff. The session sweep stops and drains during auth shutdown. Session connection expiry remains bound to the session grant.
