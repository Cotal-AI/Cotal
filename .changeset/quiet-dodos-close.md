---
"@cotal-ai/core": patch
---

Disable the NATS client's reconnect loop before an endpoint credential expires or its connection is deliberately closed. Credential-expiry closes now resolve through the connection's documented `closed()` result without an unhandled rejection.
