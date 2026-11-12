---
"cotal-ai": patch
---

Keep Manager restart preparation held until every preparing caller releases it. Local requests are attributed to their authenticated process identity, so another updater cannot release a caller's admission fence.
