---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

Delivery daemon: the launcher stops dropping the transport, and stops reporting a daemon it did not start.

Two independent defects let `cotal up` print a healthy control plane over one that was not there.

**A same-root refresh relaunched the delivery daemon without TLS (#836).** `startDeliveryWithBroker`
re-derived the transport from `<root>/.cotal/broker-policy.json` whenever its caller passed no
`transport` — and the refresh path never passed one, even though it had already decided the same
fact from the mesh-registry entry and reconciled it against the live listener's `INFO`. The two
durable records are written by different paths, so on any root that records `tlsRequired` without
holding a policy file (registered with `cotal meshes add --tls`, or a mesh predating the policy
file) the daemon went out flagless against a TLS-required broker. Nothing looked wrong: the client
still upgrades on the server's unauthenticated greeting. The daemon holds a standing credential and
reconnects unattended, so that was a repeating exposure, not a one-shot. The transport requirement
is now a required argument to `startDeliveryWithBroker`; the policy re-derivation is gone and every
call site names its source.

**A stale lease answered for a daemon that had already exited (#837).** `waitForDeliveryLease`
accepted any `ready:true` lease. A daemon killed with `SIGKILL` never releases its lease, and the
record survives for the rest of the bucket TTL — so a replacement that lost the single-flight CAS
and exited was reported ready off the corpse's lease, and `up` exited 0 with no daemon running and a
pidfile fronting a dead pid. `waitForDeliveryLease` now takes `holder` and waits for that daemon
specifically (`undefined` only when adopting one that was already running, whose id is not knowable
from the launcher). `ensureDelivery` passes the id of the daemon it launched, and a launch whose
process is provably gone while holding no lease now fails loud, naming `.cotal/delivery.log`,
instead of returning success.

`waitForDeliveryLease` now requires `holder` — pass `undefined` for the previous behaviour.
