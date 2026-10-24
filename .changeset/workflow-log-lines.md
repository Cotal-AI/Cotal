---
"@cotal-ai/core": patch
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

A workflow's `log(...)` lines are no longer discarded. A run the manager hosts writes each line to
the manager's log as `run <run-id>: log <text>`, a `--local` drive prints them, and `run simulate`
lists them under `Log`, with `result.log` in `--json`. The lines stay out of the journal, as the
language defines.
