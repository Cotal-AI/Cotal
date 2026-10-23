---
"@cotal-ai/cli": patch
---

`cotal up --channels <path>` with a file that is missing, unreadable or not JSON now refuses `USAGE_INVALID` (exit 1) and names the file, before anything is written. It used to exit 3 with `OPERATION_UNKNOWN` and no path, after writing the stack journal and creating the broker store directory, and every later `up` in that folder then refused.
