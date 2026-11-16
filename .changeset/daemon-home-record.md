---
"@cotal-ai/workspace": patch
---

Protect daemon state inside a redirected Cotal home from being used as a project folder.

Space creation and startup now treat the daemon record directory and its descendants as control paths, while still allowing project folders beside the home's records.
