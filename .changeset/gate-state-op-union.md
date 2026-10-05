---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

The issuance-gate types now carry the op rule the gate parsers already enforce. `EpGateRow`, `EndpointGateRow` and `EpGateState` declared `op` optional in every state, so each reader re-derived it with placeholders, assertions and fallbacks for a case the parsers refuse. They are now a union on `state` over a shared `GateOp`: `open` carries no op, and `frozen` and `retired` always carry one. A reader that has checked the state reads `op` directly, and an in-memory gate or barrier that freezes or retires without recording its op no longer compiles. The endpoint gate's mint fence and registration barrier also read the `epgate` row through one shared reader and one mapping into `EpGateState`, so the two `observe` members can no longer refuse a DEL marker or carry the row's fields differently. Gates that parsed before parse the same way, and the refusals are unchanged.
