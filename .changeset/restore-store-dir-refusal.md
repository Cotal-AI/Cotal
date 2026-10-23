---
"@cotal-ai/cli": patch
---

`cotal backup restore <dir> --store-dir <path>` and `cotal up --restore <dir> --store-dir <path>` refuse a store path that already exists, or whose parent directory is missing, as `USAGE_INVALID` (exit 1), naming the path, before anything is staged. Both used to exit 3 with `OPERATION_UNKNOWN`, "store path must be absent" or a raw `ENOENT`, and a Next that said the journal names no restore attempt.
