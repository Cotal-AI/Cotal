---
"@cotal-ai/workspace": patch
---

A runtime record, or a `.cotal` listing, that exists but cannot be read now fails with its read error instead of reading as absent. An unreadable record used to count as not running and an unlistable `.cotal` as holding no records, so `cotal status`, `cotal down`, `cotal clean` and the start helpers scoped a root running two spaces to the readable one, and a start went ahead past a live pre-upgrade record it could not list. Only a missing file or directory still reads as absent.
