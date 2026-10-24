---
"@cotal-ai/runtime": patch
---

`cotal run revoke --local` with an empty or blank `--by` or `--reason` now names that flag, says
nothing was written and gives the command to run, without printing the whole `run` help.
