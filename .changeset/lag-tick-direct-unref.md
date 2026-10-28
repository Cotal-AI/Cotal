---
"@cotal-ai/runtime": patch
---

Call `timer.unref()` directly on the loop-lag tick timer in `host-starvation.ts` instead of `timer.unref?.()`, removing the misleading DOM/bundler comment and failing loudly if a timer lacks `unref`.
