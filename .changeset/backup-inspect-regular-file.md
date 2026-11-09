---
"@cotal-ai/cli": patch
---

`cotal backup inspect` now refuses an artifact whose declared file is a symbolic link, FIFO or device, naming that file and the fault `not-regular`.

Verify and restore already refused that file. Inspect checked the declared names and then reported the artifact as fine, so an operator who inspected before restoring was told a copy that cannot be restored was sound.
