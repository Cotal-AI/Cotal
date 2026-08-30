---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

Expose raw NATS transport liveness separately from full endpoint readiness. Connector sessions now
track transient disconnect and reconnect edges without flapping readiness, ignore stale events from
replaced connection epochs, and clear both states on stop. Connection issues remain scoped to pre-bind
readiness failures, clear on a successful bind, and survive stop for post-mortem diagnosis.

An endpoint stopped while its bind is still in flight also no longer announces that connection.
The bind's own teardown already discarded it, but the readiness event was emitted first, so any
listener on the endpoint was left holding a connected edge that nothing ever corrected.

The same applies to the transport seed, which reaches further back. It fires as soon as the dial
returns, well before the bind completes, so a stop arriving while the dial was still pending had a
stopped endpoint announce a live transport it never had. Both edges are now guarded.
