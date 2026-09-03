---
"@cotal-ai/core": minor
"@cotal-ai/web": patch
---

Distinguish an unpopulated presence watch from a current roster.

`presenceView()` now returns a discriminated `current`, `unpopulated`, or `stale` state. An
unpopulated reconnect refill carries `fresh: false`, so existing consumers fail toward unknown
instead of treating a partial roster as an authoritative absence verdict. `waitForPresenceSnapshot()`
now reports whether the snapshot completed or the bounded wait timed out.

The web dashboard surfaces an unpopulated roster as still loading and keeps the existing stale-watch
diagnostic for a view that was populated and later went silent.
