---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
"@cotal-ai/workspace": patch
---

JSON error receipts report the unsafe preferences folder warning without repeating it on stderr. The warning stays visible when a command exits without a receipt or when writing the receipt fails for a reason other than a closed pipe.
