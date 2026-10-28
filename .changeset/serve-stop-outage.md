---
"@cotal-ai/manager": patch
---

A manager stop no longer waits out a broker outage while it retires its service-endpoint serve connection. Draining that connection's subscriptions and the connection itself waits for a reconnect, so a stop during an outage lasted as long as the outage, and `cotal down` could kill the manager before its endpoint and attach listener stopped. A serve connection whose transport is down is now closed without a drain.
