---
"@cotal-ai/core": patch
---

`serveEndpoint(...).stop()` settles when its connection closes mid-drain. nats-core settles a subscription drain on the server's PONG and rejects no pending flush when the connection closes, so a stop that raced the connection's close, or ran on a closed connection, never settled. Each drain is now bounded by the connection's own `closed()`, and in-flight handlers are still awaited before the stop reports stopped.
