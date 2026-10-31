---
"@cotal-ai/manager": patch
---

A manager stop during a broker outage no longer waits out the outage while retiring its goal-writer and session-ledger connections. These two connections, like the serve connection, now track their transport, and one `retireConnection` helper drains each while it is connected and closes it while the client is reconnecting it. Before, the goal-writer drain waited for the reconnect. The session-ledger stop left the connection's close unawaited after its drain failed.
