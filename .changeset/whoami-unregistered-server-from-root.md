---
"@cotal-ai/cli": patch
---

`cotal whoami --server <address>` from a space's own folder now reports an address that space is not registered at as `BROKER_NOT_PROBED`: partial, exit 4, with the identity unknown and a remedy naming `cotal whoami --space <space>`. It used to report full access as complete, because the folder holds the space's signer, while the same command from a folder with no trust was already reported unprobed. `--space <space> --server <address>` is treated the same way.
