---
"cotal-ai": patch
---

Fix the Windows desktop app's first screen. In 0.164.10 and 0.164.11 the bundled CLI did nothing when Node was given its script through an extended-length (`\\?\`) path, which is how the app starts it, so every request from the app ended in "This operation could not finish". Installing the 0.164.12 app repairs it; the `cotal` command installed with npm was not affected.
