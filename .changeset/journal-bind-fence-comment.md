---
"@cotal-ai/lang": patch
---

The journal's seed-check comment now names `enterStep` and `performScope` as the write-side guards on a step's binding, and `recordableError` as the guard on `error.detail`. It used to name `performEffect`, which holds neither check; `performEffect` and `performWaitUntil` both bind through `enterStep`. No behavior changes.
