---
"cotal-ai": patch
---

Keep daemon command discovery from loading the Manager implementation before an operation needs it. Load the vitals sampler and registration cleanup helper at their existing asynchronous operation boundaries.
