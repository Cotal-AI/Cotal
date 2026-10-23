---
"@cotal-ai/core": patch
---

`epWatchEvents(...).stop()` settles when its connection closes mid-drain, the same way `serveEndpoint(...).stop()` does since 0.97.0: nats-core settles a drain on the server's PONG and rejects no pending flush when the connection closes, so a stop racing the connection's close hung. The drain is now bounded by the connection's own `closed()`, and a stop on an already-closed connection settles instead of rejecting.
