---
"@cotal-ai/cli": patch
---

`cotal history --dms` names a DM's recipient from the roster when no message in the window came from it, so a DM to a participant that has sent nothing reads `DM to <name>`. It used to show the principal.
