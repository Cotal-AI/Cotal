---
"@cotal-ai/cli": patch
---

`cotal up` in the home folder, whose `.cotal` holds this machine's own records, now refuses `CONFLICT` and names a project folder, as `space create` does there. A home that already holds a stack an earlier release started there keeps starting it in place, and `up --root <dir>` still starts a prepared project from the home. A `cotal down` in a home with no stack says there is nothing to stop.
