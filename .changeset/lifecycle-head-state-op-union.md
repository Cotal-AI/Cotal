---
"@cotal-ai/core": minor
---

Breaking: `LifecycleMapping` is now a union on `state` that carries the op rule `parseLifecycleHead` already enforces. It declared `op` optional in every state, so each head reader re-derived the rule with a `<none>` placeholder, an `undefined` in a message or a conditional `opId` for a case the parser refuses. A `retiring` head now always carries its retirement op, and an `active` or `retired` head carries none. A reader that has checked the state reads `op` directly, and an in-memory head that is `retiring` without its op, or `active` or `retired` with one, no longer compiles. Because it is no longer an interface, an `interface` that extends `LifecycleMapping` fails with TS2312; declare it as an intersection such as `type ActiveMapping = LifecycleMapping & { state: "active" }` instead. Heads that parsed before parse the same way, and the refusals are unchanged.
