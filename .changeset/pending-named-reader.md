---
"@cotal-ai/delivery": patch
"cotal-ai": patch
---

`cotal pending <agent>` now exits 0 when its bounded candidate read finishes and the temporary reader is deleted.

The admin credential cannot delete the unnamed consumer the read used to open, so every healthy count was reported as a partial failure. The read now uses that credential's own history reader, deletes it by name, and reports partial only when the read or that deletion does not finish.
