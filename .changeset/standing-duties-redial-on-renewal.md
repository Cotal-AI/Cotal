---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager's standing connections that the broker closed as their old credentials expired now come back as soon as the renewed credentials are adopted. The manager's own endpoint used to stay down until its reconnect backoff ended, up to a minute, and the goal-writer and session-ledger connections waited a fixed second. `CotalEndpoint.refreshCredsRequestSafe()` now redials an endpoint that is re-establishing instead of refusing. A closed standing connection makes its first re-dial attempt when an in-flight renewal adopts, and a goal-writer or session-ledger connection whose credential expired makes it at once, which starts the renewal.
