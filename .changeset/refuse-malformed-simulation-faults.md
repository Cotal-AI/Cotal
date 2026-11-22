---
"@cotal-ai/runtime": patch
---

`cotal run simulate` refuses malformed fault entries instead of silently ignoring a typo. The `SCHEMA_INVALID` refusal names the results file and the entry to correct.
