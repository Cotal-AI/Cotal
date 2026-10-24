---
"@cotal-ai/runtime": patch
---

`cotal run check` of a run ID with no record on the endpoint is now refused `TARGET_NOT_FOUND`, exit
2, with `cotal run` as its Next, as `run show` refuses it. It used to print a bare line and exit 1.
