---
"cotal-ai": patch
---

On Linux, repeating `cotal daemon install` refreshes the recorded service PATH when an application that `cotal status` lists is on this shell's PATH and not on the unit's pin. It restarts only when no agent is running, and leaves a drop-in, pending reload, hand edit, or another installation unchanged.
