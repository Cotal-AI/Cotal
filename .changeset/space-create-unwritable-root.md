---
"@cotal-ai/cli": patch
---

`cotal space create <name> --root <dir>` on a folder this account cannot write, such as `/`, now refuses `PERMISSION_DENIED` (exit 2) with "<dir> is not writable by this account, so its .cotal could not be made; nothing was written" and a next step, rather than exiting 3 with an unknown outcome and a raw `EACCES` error. Nothing is written in either case. `cotal setup` prepares a space through the same step and refuses the same way.
