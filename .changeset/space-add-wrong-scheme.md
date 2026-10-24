---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`space add --server` with `tls://`, `ws://` or `wss://` against a port that greets as a plain NATS
broker now says the scheme failed and names the URL to register. It used to say that no broker
answered, as it does for an address where nothing listens.
