---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A prepared space whose recorded path is now a file, not a project folder, is reported as such instead of being offered a start there: `space show` and the listing name the file with restore-or-forget steps, commands naming it refuse with the same guidance, and `space forget` removes the stale preparation instead of failing on the pidfile it cannot read.
