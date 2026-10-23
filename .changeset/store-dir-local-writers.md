---
"@cotal-ai/cli": patch
---

The existing part of an explicit `--store-dir` path on `cotal up`, `cotal up --restore` or `cotal backup restore` is now held to the rule `space create` applies to a project root. A group- or world-writable directory in it refuses `PERMISSION_DENIED` before anything is written, naming the path and its `chmod` remedy. `up` used to start the stack on such a store and leave the directory writable by other local accounts. A non-empty directory is still accepted.
