---
"@cotal-ai/cli": patch
---

`cotal space add` outside a project with no `--root` now refuses with one line and a remedy that says what to pass, instead of printing the whole `space` help. The line no longer describes the folder only in terms of credentials: an open space keeps none there, so any folder will do.
