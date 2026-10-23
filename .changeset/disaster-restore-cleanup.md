---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`backup cleanup-fallback` now retires the journal of a restore made with `--accept-missing-source`.
That restore replaced a missing source and keeps no old store, so cleanup refused with an unknown
outcome, every other recovery route refused too, and the root could never start another backup
cycle. Its plan, prompt and receipt now say that nothing is removed, and `clean restore-fallback`
does the same.
