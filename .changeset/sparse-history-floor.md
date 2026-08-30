---
"@cotal-ai/core": patch
---

Sparse channelHistory stops at the subject's first matching sequence instead of walking the stream to sequence 1. The page was already correct; the walk is now the channel's own span.
