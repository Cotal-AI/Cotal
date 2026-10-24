---
"@cotal-ai/auth": patch
---

`cotal auth handle inspect` of a path that names nothing now refuses `TARGET_NOT_FOUND` and names
the path, where it used to refuse `DEPENDENCY_UNAVAILABLE` with no path.
