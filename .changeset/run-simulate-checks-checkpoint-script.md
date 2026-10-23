---
"@cotal-ai/runtime": patch
---

`cotal run simulate` refuses a results script whose scripted checkpoint result is not one `checkpoint()` can return, with `SCHEMA_INVALID` (exit 1) naming the checkpoint and the problem. A status other than `resolved` or `expired`, a missing status, a non-object entry, an unknown field or a scripted `at` used to simulate as a resolved answer and report `ok`, and a scripted `at` was dropped without a word.
