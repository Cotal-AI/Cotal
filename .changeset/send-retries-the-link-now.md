---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

An agent can post again as soon as its space is back after a long outage. The endpoint retried a lost connection with a backoff that grows to a minute, and a send made while it waited failed after 10 seconds with a stale "connection refused". A call that needs the connection now starts the next attempt at once. Idle endpoints keep the spread-out retries.
