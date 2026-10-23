---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Observers and chat sessions no longer hang silently after a broker outage the client could not ride out. `watch --plain` and `console --plain` now resume when the broker comes back, as `history --follow` already did: the endpoint re-subscribes their feed on every reconnect, where before it subscribed once and stayed silent while reporting itself connected. A `chat --stdio` or `--plain` session whose inbox is gone from the broker after the outage, as when `cotal up` restarted the space and retired it, no longer reports reconnecting forever. It ends by itself with that reason, its `--stdio` end record and `close` carry it, and it exits 5. An endpoint stopped from its own warning listener also exits promptly instead of waiting out the reconnect backoff.
