---
"@cotal-ai/runtime": patch
"@cotal-ai/lang": patch
---

`cotal run simulate` refuses malformed fault entries instead of silently ignoring a typo. The `SCHEMA_INVALID` refusal names the results file and the entry to correct. A fault entry can use a step key alone to inject the default fault at that step.
