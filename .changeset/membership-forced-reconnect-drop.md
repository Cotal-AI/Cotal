---
"@cotal-ai/core": patch
---

The membership feed no longer logs "CONNZ sweep omitted our own rw connection" for a sweep that ran while its own credential adoption was reconnecting the data connection. nats.js resolves a forced reconnect before the connection's status stream reports the drop, so the feed now counts that drop when it starts the reconnect.
