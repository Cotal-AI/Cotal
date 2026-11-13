---
"@cotal-ai/runtime": patch
---

`cotal run start` no longer says a start was refused when its reply was lost. If the request reached the manager but no reply came back before the deadline, the CLI printed "Request refused" and `TARGET_UNAVAILABLE`, though the manager had recorded and completed the run, so a retry started a second run. A `start`, `resume`, `answer` or `amend` whose request went out and drew no reply is now `OPERATION_UNKNOWN`, exit 3, with the advice to read the run or list the runs before running it again. A manager that did not answer before the request was sent, or that the broker found no subscriber for, is still `TARGET_UNAVAILABLE`.
