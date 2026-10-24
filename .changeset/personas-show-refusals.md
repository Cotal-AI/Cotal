---
"@cotal-ai/cli": patch
---

Legacy `personas show` now refuses as `persona show` does: a missing persona with `TARGET_NOT_FOUND`
(exit 2), an invalid definition with `SCHEMA_INVALID` instead of printing it, and a name no persona
can have by the rule it breaks instead of "no persona". A valid persona is still written byte for
byte.
