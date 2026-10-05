---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
---

Breaking: the `ai.cotal.ep.lifecycle-blocked` refusal detail now reports only the state the refusing site read. `headState` is optional and set only where the lifecycle head was read; a new `gateState` (`frozen` or `retired`) is set where the issuance gate was read. A gate frozen by a takeover, a registration or another retirement used to report `headState: "retiring"` over an active head or a service instance with no head, and a retired gate reported `headState: "retired"` with no head. `blockedOp` is the gate's own op kind instead of defaulting to `registration`, and `registerServiceInstance` refuses a frozen gate observed without a valid op (a string `opId` and one of the four op kinds) as `internal`. The manager's reserved-name refusal no longer claims a head state. A client that read `headState` from a gate refusal must read `gateState`.
