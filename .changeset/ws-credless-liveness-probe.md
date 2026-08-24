---
"@cotal-ai/core": patch
---

The credless liveness probe spoke plaintext NATS at ws/wss servers, reading TLS
bytes and declaring a live broker down — which blocked `spawn` and reachability
reads with a wrong remedy. On ws servers it now dials the websocket transport
credless; an auth broker rejecting the bare connect still proves it is there.
