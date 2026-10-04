---
"@cotal-ai/web": patch
---

The dashboard's all-activity page now says why each missing source is missing. A partial page carries `reasons`, keyed by source, and the server's partial line and the page's stale marker repeat it. A read the deadline cut says it did not finish within the deadline, and a read that was refused says so with its error, so a chat read refused for exceeding the broker's `max_payload` no longer looks the same as one that ran out of time.
