---
"@cotal-ai/cli": patch
---

`up` refuses a `--store-dir` that does not exist while the root's last served store still holds data, since the start would open a new empty store at a mistyped path; creating the directory first names a new store on purpose. A `--store-dir` path this account cannot create is refused `PERMISSION_DENIED` before anything is written, instead of failing with a raw `EACCES` from `mkdir`.
