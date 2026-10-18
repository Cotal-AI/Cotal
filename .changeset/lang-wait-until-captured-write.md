---
"@cotal-ai/lang": patch
---

`validate()` now refuses with L2032 a `waitUntil` probe or `terminal` predicate that writes a binding declared, or a value built, outside it. Both engines run them one level deeper than the call and refuse the write at run time, so such a program used to validate clean and then fail on the first observation of every run.
