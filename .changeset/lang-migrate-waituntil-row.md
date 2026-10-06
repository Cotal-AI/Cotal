---
"@cotal-ai/lang": patch
---

The cotal-lang spec's migrate orphan table has a `waitUntil` row. An orphaned `waitUntil` is ignored whether it settled or is still pending, and its recorded observations stay in the journal. This is what `cotal run migrate` already reported; the table's "any other kind" row required L5015, so an implementation written from the spec refused the same migrations. No behavior changes.
