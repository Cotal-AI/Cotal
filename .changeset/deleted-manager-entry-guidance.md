---
"@cotal-ai/cli": patch
---

Update refusals identify local Managers whose launch entry is missing and explain how to proceed.
The refusal includes the process start time, working directory and launch entry path. Missing paths remain subject to the existing ownership checks because a deleted launcher symlink may have pointed into the current installation.
