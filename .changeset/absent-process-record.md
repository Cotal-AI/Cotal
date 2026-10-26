---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Omit `path` from absent process records, including missing files and empty pidfile husks. Narrow `ProcessRecord` by `state` before reading its evidence fields. Non-absent records keep the path that was read, including pre-upgrade spellings.
