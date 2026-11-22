---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Cotal reports when a prepared space's project path is occupied by a file and shows how to recover. Space inspection leaves the file and preparation untouched, and `cotal space forget` can remove the stale preparation without changing the file.
