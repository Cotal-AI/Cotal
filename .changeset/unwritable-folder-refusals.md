---
"@cotal-ai/cli": patch
---

`cotal up` in a project whose `.cotal` this account cannot write, and `cotal persona edit` with a
`TMPDIR` that is missing, not a folder or not writable, now refuse with exit 2 and name the folder
and a next step, before anything is started or written. They used to end `OPERATION_UNKNOWN` (exit 3)
with a raw `EACCES` or `ENOENT` and the name of an internal file.
