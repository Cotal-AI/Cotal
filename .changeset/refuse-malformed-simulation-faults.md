---
"@cotal-ai/runtime": minor
"@cotal-ai/lang": patch
---

`cotal run simulate` refuses malformed fault entries instead of silently ignoring a typo. The `SCHEMA_INVALID` refusal names the results file and the entry to correct. A fault entry can use a step key alone to inject `L4002`, or supply an `L3xxx` or `L4xxx` code.
