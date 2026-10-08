---
"@cotal-ai/core": patch
---

`writeSecretFile` now sets mode `0600` on the open file before it writes the bytes, so replacing an existing file no longer keeps that file's mode on POSIX. The mode passed at open applied only when the call created the file, and a secret written over a `0644` file stayed `0644`. This covers `cotal mint --out` over an existing credentials file and `cotal mint --signer --force`.
