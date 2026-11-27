---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Follow an owned private preferences folder reached through a symbolic link, the same way an update already follows that home.
Use that same check for a trust write under the config folder, and write the file in the physical folder the check names.
Refuse a dangling link and a link that steps back through an unprotected folder, and never name a chmod for a folder this account does not own.
