---
"@cotal-ai/cli": patch
---

`persona edit` and `personas edit` run an editor setting that is the path of an existing file as
that program, so a path that holds spaces opens the editor. It used to run through the shell, which
split the path and refused it as not found after a raw `/bin/sh` line.
