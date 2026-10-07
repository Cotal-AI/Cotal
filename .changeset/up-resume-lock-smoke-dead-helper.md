---
"@cotal-ai/cli": patch
---

The up-resume-render-lock live smoke no longer defines `tryLock()`, a lock-acquiring helper that nothing called. The comment on its read-only control now names the risk of an independent acquire directly instead of pointing at that helper. Shipped behaviour is unchanged.
