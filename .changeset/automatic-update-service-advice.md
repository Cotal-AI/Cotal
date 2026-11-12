---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Explain when a saved automatic-update preference has no active daemon schedule.
Enabling or reading the Linux preference now checks the daemon and names the service installation and status commands when needed, without installing or starting anything.
