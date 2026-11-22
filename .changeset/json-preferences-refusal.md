---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

JSON error receipts report the unsafe preferences folder warning without repeating it on stderr. If a refusal receipt cannot be written for a reason other than a closed pipe, the text report includes the warning.
