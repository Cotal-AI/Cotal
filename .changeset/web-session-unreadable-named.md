---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal status --components` now names a `web.session` that exists but cannot be read, for example after an ownership or mode change: the web row reads `refused · web.session unreadable: <error>`. The reader used to treat every read error as no record, so a live dashboard read `refused · probe refused (no bound address recorded)`, and the `Web process` row and the `cotal setup` card read `down`. Those two rows now name the unreadable record as well. Only a missing, empty or partial `web.session` still reads as no record.
