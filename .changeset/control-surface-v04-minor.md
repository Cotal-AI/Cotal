---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/delivery": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---

v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

Adds the endpoint control surface: the `ep` request rails and grant grammar, the
message envelope and error catalog, the callable-service verbs, and the session
and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
Requires nats-server 2.12 or newer, since the auth marker store uses native
per-message TTL; clients read the server version from the pre-auth INFO and fail
loud below the floor.

Completes the agent lifecycle end to end: registration, admission, despawn,
retirement, and safe name reuse, backed by a lifecycle registry, a credential
ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
manager-resumed agent recovers its original incarnation rather than re-minting,
and readiness is incarnation-exact. The connectors forward the lifecycle uid into
spawned children so a child joins as its intended incarnation.

From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
omits it is treated as pre-0.4 and is not addressed on the endpoint rails.
