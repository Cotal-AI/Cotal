---
"@cotal-ai/manager": patch
---

A manager stop no longer waits out a broker outage. Draining the serve, goal-writer or session-ledger connection waited for a reconnect, and deregistration waited out a 20 s dial, so a stop during an outage lasted as long as the outage and `cotal down` could kill the manager before its endpoint and attach listener stopped. A frozen broker held the stop for minutes. Each of those connections is still drained when the broker answers. When its transport is down, drops during the drain, or the broker gives no answer within a 2 s budget the stop shares across them and the deregistration, the connection is closed and the manager prints a warning that names it.
