---
"@cotal-ai/workspace": patch
---

Extension add now installs packages whose entry points at a directory, resolving it to the directory's index file the way Node does instead of failing the import and rolling the install back.
