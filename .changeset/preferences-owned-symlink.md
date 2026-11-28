---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Follow an owned private preferences folder reached through a symbolic link, the same way an update already follows that home.
Use that same check for a trust write under the config folder, and write the file in the physical folder the check names.
For preferences and trust, refuse dangling links and links that step back through unprotected folders, and suggest permission changes only for folders you own.
