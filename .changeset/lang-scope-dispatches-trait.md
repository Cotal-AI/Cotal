---
"@cotal-ai/lang": patch
---

Whether a scope calls the handler itself is now its own `dispatches` row in `scopeTraits`, and `performScope` reads it there. Before, it inferred dispatch from whether the scope hashes a subject, so changing `conclave`'s `hashesSubject` still typechecked and then silently dropped the conclave's durable request id, its cancel re-check after begin and its count against the effect ceiling (L4009), and let a migration walk into a settled conclave and call the handler's `openConclave` where it used to refuse with `UnwalkableScope`. Shipped behaviour is unchanged.
