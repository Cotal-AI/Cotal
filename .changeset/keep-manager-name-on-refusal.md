---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

A refused `cotal up` leaves the saved manager name unchanged. Once the requested manager is ready, `up` saves its name and reports a warning if the save fails. When reusing a manager, `up --manager-name` checks the live manager's name instead of the saved name.
