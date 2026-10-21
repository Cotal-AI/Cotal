---
"@cotal-ai/core": patch
---

Keep create-only private temporary filenames independent of the destination basename so long native service phase records can be published without exceeding the filesystem component limit. Preserve exclusive temporary creation and atomic no-replace hard-link publication.
