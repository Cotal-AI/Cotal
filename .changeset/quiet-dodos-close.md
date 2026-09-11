---
"@cotal-ai/core": patch
---

Disable the NATS client's reconnect loop before an endpoint credential expires or its connection is deliberately closed, then close that connection instead of draining it. Credential-expiry closes resolve through `closed()` without an unhandled rejection, and a half-open socket cannot leave teardown waiting for a drain PONG.
