---
"@cotal-ai/delivery": patch
---

`docs/delivery-daemon.md` now describes the broker watch the delivery daemon runs. It no longer says a two-second authenticated broker probe is the active watch; after its start-up reachability check the daemon opens no other connection to check the broker. The page names the disconnect that starts the clock, the window (`COTAL_DELIVERY_BROKER_GONE_MS`, 15 seconds by default) that credits time the daemon itself was stalled, the absolute backstop (`COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS`, four times the window by default), the exit line each one logs, and how an expired credential is handled. No behavior changes.
