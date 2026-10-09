---
"@cotal-ai/lang": minor
---

`PrimitiveSpec.opensScope` is replaced by `scope`, the `ScopeKind` a primitive opens or `null`. A scope row in `PRIMITIVES` now has to name a member of `ScopeKind` to compile, and both engines read that kind from the table instead of casting the primitive's name to it, so a new scope primitive left out of the union no longer reaches the journal as a kind its readers do not know. Code that read `spec.opensScope` reads `spec.scope !== null`.
