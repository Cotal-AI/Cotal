---
"@cotal-ai/runtime": patch
---

`cotal run simulate` now refuses a results script whose `clock` has a field it does not know, such as `clock.checkpoints`. The misspelled field used to be ignored, so the simulation ran with the one-minute default instead of the delay the author wrote. The refusal is `SCHEMA_INVALID`, names the field and the file, and names the singular field when the typo is its plural.
