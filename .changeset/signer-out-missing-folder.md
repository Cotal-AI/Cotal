---
"@cotal-ai/workspace": patch
---

`cotal auth signer --out <file>` into a folder that does not exist no longer ends in a raw `ENOENT … lstat` with exit 3 and "Outcome unconfirmed". It refuses `TARGET_NOT_FOUND` before anything is written, names the folder, and gives `(umask 077 && mkdir -p <folder>)` as the next step, which makes every missing folder private. No folder is created for signing material.
