---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

Expose raw NATS transport liveness separately from full endpoint readiness. Connector sessions now
track transient disconnect and reconnect edges without flapping readiness, ignore stale events from
replaced connection epochs, and clear both states on stop. Connection issues remain scoped to pre-bind
readiness failures, clear on a successful bind, and survive stop for post-mortem diagnosis.
