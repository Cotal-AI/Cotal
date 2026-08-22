---
"@cotal-ai/core": patch
---

Reopen the derived membership-feed KV after an endpoint reconnect. The feed handle is connection-scoped, so retaining it across a connection rebuild made membership reads and watches fail with `closed connection` while the endpoint's other planes had recovered.
