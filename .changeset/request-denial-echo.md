---
"@cotal-ai/core": patch
---

`CotalEndpoint` no longer emits an `error` event for a publish denial that the broker already returned to a request. nats.js rejects the request with the denial and also reports the same denial on the connection status, so a call that handled it as its result still produced an `error`, and an endpoint with no `error` listener crashed. An observer's `dmHistory()` returned `[]` and then took down a host with no listener. Refused subscriptions and refused publishes that no request was waiting on are still emitted.
