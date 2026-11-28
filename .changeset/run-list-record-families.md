---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

`cotal run` lists the runs recorded on a manager without reading the rest of that manager's record store, so a store that has grown for days still answers inside the list budget. A list that still misses its budget says to read one page with `cotal run --page`, instead of saying the same list is safe to run again.
