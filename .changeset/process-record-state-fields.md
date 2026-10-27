---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`ProcessRecord` now says which evidence each state carries. An `absent` record has none, a `dead` or `unknown` record has its pid, an `unattributable` record has the content that was not a pid, and an `alive` or `foreign` record has its pid and the command line when that line was readable. Every non-absent record still carries the path of the file that was read. Narrow by `state` before reading a field: a read of `pid` on an absent record, or of `content` on an alive one, is now a type error. The reader already returned these shapes, so nothing it returns changes.
