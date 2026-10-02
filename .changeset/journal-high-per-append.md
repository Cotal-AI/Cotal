---
"@cotal-ai/runtime": patch
"@cotal-ai/core": patch
---

A run driver now advances the run record's `journalHigh` after every journal append, before the program acts on the entry. A tail delete of records appended since the last activation used to leave a short journal that a successor resumed from, performing those effects again. The successor now refuses it with `RunJournalTailTruncated`.
