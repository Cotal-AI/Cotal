---
"@cotal-ai/auth": minor
"@cotal-ai/core": minor
---

Expose the auth context's owned connection inventory and terminal `closed` signal (#3054). Underlying connection close failures now reject with their labels instead of being suppressed. Add a read-only, space-bound `readPlaneClaim` export (#3270) and an account-scoped `observeAccountLivenessWithCreds` observer over the existing native CONNZ sweep.

UPGRADING (`@cotal-ai/auth`): After `close()` or `drain()`, await `handle.closed` to prove all owned connections ended. `handle.connections()` returns a detached snapshot, including replaced readiness readers and short-lived clients. A close failure leaves the end signal pending while a connection remains live. Repair the failure and retry `close()` before awaiting the terminal signal. Read another process's claim with `readPlaneClaim(kv, space)` using that account's leader-only auth bucket. An unclaimed space returns `undefined`. Deleted or malformed claim rows refuse, and the package now exports `PlaneClaimRow` and `PLANE_CLAIM_KEY`.

UPGRADING (`@cotal-ai/core`): Use `observeAccountLivenessWithCreds({ servers, observerCreds, accountId, options })` with the same account-scoped membership-observer credentials used by the tuple query. It returns connection labels, server ids, cids, identities and the sweep's `gotAnyReply`, `truncated`, `sweepComplete` and topology facts. Zero rows prove absence only with a complete sweep and the single-server proof. Credentials are never widened and the observer performs no eviction. Trusted endpoint composition roots may use `EndpointOptions.onConnection` to retain custody of each opened transport and await its terminal signal.
