---
"@cotal-ai/core": patch
---

A channel replay window too long to be a start time, such as `--window 999999999999999999999999d`, now backfills the whole retained history. A new session received no retained posts at all, with no warning, although `cotal channel set` had accepted the window.
