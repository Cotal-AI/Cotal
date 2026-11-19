---
"@cotal-ai/cli": patch
---

`cotal` and `cotal help` now explain when the working directory has been removed, even when `PATH` contains relative entries. Help still finds executable paths that do not depend on the removed folder.
