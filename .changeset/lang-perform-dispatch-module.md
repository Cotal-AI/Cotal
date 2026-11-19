---
"@cotal-ai/lang": patch
---

Move per-primitive dispatch (`dispatchPrimitive`, its hashed projections and the `waitUntil` observation loop) out of `perform.ts` into an internal `perform-dispatch.ts`. The package surface is unchanged.
