---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/auth": minor
---

Selections made with `cotal use` now apply in every folder, overriding the folder's running space.

Automatically adopted selections preserve running-project targeting. Older selection pointers are treated as explicit until cleared. Native foreground spawn prints its target and uses this terminal without asking again, while detached launches still require a Manager choice when no default exists.
