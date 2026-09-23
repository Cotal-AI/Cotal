---
"@cotal-ai/core": minor
"@cotal-ai/delivery": patch
---

`Part`'s data arm is `{ kind: "data"; data: unknown }` no longer: `data` is now the exported `JsonValue` (null, boolean, number, string, array, or an object of JSON values), so a part whose `data` is `undefined` (or a function, symbol, or bigint) no longer type-checks, and every publish path (`unicast`, `multicast`, `anycast`, `multicastExpecting`) refuses it at runtime with a named error instead of serializing it to a keyless `{"kind":"data"}` row. That row was accepted by the producer and then read two different ways: DM history returned it while Plane-3 durable delivery terminated it as malformed. A `data` part carrying `null` or any other JSON value is unchanged. SPEC §5 now states the rule. The delivery daemon's feedback intake keeps publishing its record as a data part with type declarations only (no runtime change). Refs #1404.
