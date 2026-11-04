---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal who` and `cotal_roster` now decide a shared display name the same way. Both asked their own copy of the count, so a change to how names compare had to be made twice and kept in step with `resolvePeer` by hand. One core helper, `sharedNameIds`, uses the comparison `resolvePeer` uses (trimmed, then case-insensitive) and returns the instance ids whose name another roster row carries. Each surface still writes that id in its own form: `cotal who` as ` [<id>]` and `cotal_roster` as ` — id: <id>`.
