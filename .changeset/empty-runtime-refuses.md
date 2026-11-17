---
"@cotal-ai/cli": patch
---

`cotal up --runtime ""` and a blank `--runtime` refuse `USAGE_INVALID`, exit 1, before anything is started or written. Before, an empty value, as an unset variable gives, started the stack on the default runtime.
