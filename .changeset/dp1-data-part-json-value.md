---
"@cotal-ai/core": minor
"@cotal-ai/delivery": patch
---

`Part`'s data arm is `{ kind: "data"; data: unknown }` no longer: `data` is now the exported `JsonValue` (null, boolean, finite number, string, an array of JSON values, or a plain object of JSON values), and every publish path (`unicast`, `multicast`, `anycast`, `multicastExpecting`) refuses a non-JSON value at ANY depth at runtime with a named error that names the offending member's path (e.g. `data[2].at is not a JSON value`). Before, a value `JSON.stringify` silently rewrote could reach the wire: `undefined` became a keyless `{"kind":"data"}` row that history returned while Plane-3 durable delivery terminated it as malformed, and `NaN`, `Infinity`, `Date`s, sparse arrays, `Map`s, and `Buffer`s were rewritten to values a reader cannot distinguish from real ones; nested bigints and cycles threw from stringify instead of the named error. A `data` part carrying `null` or any other JSON value is unchanged. SPEC §5 states the rule. The delivery daemon's feedback intake keeps publishing its record as a data part with type declarations only (no runtime change). Refs #1404.
