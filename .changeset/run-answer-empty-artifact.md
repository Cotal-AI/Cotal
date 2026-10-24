---
"@cotal-ai/runtime": patch
---

`run answer` and `run amend` refuse an empty or blank `--artifact` with `USAGE_INVALID` naming the
flag. An empty one used to print the manager's raw schema error, and a blank one was recorded.
