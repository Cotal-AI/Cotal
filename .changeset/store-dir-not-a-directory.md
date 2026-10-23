---
"@cotal-ai/cli": patch
---

An explicit `--store-dir` on `cotal up`, `cotal up --restore` or `cotal backup restore` that names a regular file, or a path under one, now refuses `USAGE_INVALID` (exit 1) before anything is written, naming the file as not a directory. `up` used to exit 3 with `OPERATION_UNKNOWN` "the controller stack did not start every planned member" without naming the path, after writing its stack journal, and the restores exited 3 with "store path must be absent".
