---
"@cotal-ai/cli": patch
---

Diagnose an open space's own root with a bare `cotal doctor auth` whatever space is selected.

With another folder's space selected, `cotal doctor auth` in an open space's root exited 4 and said to run it in a space's root folder, which is where it already ran. It now reads the space registered at that root and reports that an open space has no credentials to check, as `--space` already did.
