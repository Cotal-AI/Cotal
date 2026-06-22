---
"@cotal-ai/core": minor
"@cotal-ai/delivery": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

feat(delivery): server-side delivery daemon for the Plane-3 durable backstop, + auth-by-default

Extracts the durable backstop (the offline catch-up tier) out of the manager into a standalone,
least-privilege, server-side **delivery daemon** (`@cotal-ai/delivery`, the `deliver` command). The
manager is now lifecycle-only (spawn/despawn/stop/attach/ps); the daemon owns all of Plane-3 — the
fan-out writer + trusted reader, the durable-membership registry, the runtime durable join/leave/list
ops (on a new `ctl.delivery` control service), activation catch-up, and a single-flight lease — and
re-authorizes durable delivery against a durable read-ACL registry. Live channel reads are unchanged
(native NATS, broker-enforced). No wire break (`protocolVersion` stays 0.2).

- The daemon is part of the server: `cotal up` starts it by default and it is coupled to the broker
  (it exits if the broker is gone; `cotal down` / `cotal up` shutdown stop it).
- **The mesh is now JWT-authed by default** — `cotal setup`/`go`/`up` bring up an authed mesh with the
  durable backstop; pass `--open` for the previous frictionless open, live-only mesh.
- `cotal_channels` reports honest durable-delivery health (membership + lease aware).

Hardened over multiple review rounds (sender-bound `ctl.delivery` replies, reconnect-safe responder +
KV handles, ACL-independent leave so revocation closes the §7 boundary, signer-free daemon runtime,
responder-after-bind readiness, pid-bound cutover marker), each with a guard smoke.
