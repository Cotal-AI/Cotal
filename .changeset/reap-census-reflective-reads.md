---
"@cotal-ai/manager": patch
---

The reap census reads manager.ts with the type checker: any value whose type carries `reap` is a runtime, so an alias, field, return value, awaited promise, conditional, rest copy or destructured binding needs no shape of its own, an untyped value fails closed, and a spread, rest copy or `Reflect.*`/`Object.*` call that takes a runtime is a bypass.
