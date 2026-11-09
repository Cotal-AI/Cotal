---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A connected chat session ends and says its inbox is gone when a manager restart removes that inbox.

The endpoint warns as soon as the broker reports that DM consumer deleted, and the session closes with that reason instead of staying connected with no record. The process exits 5 when the connection close is confirmed, including when the old manager does not answer the retirement. A later send to the old name is refused rather than stored (#6017).
