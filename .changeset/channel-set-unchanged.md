---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal channel set` and `channel defaults` write nothing when the entry already holds every value given, and report a `no-op` receipt, `Channel unchanged` or `Channel defaults unchanged`, instead of rewriting the entry and saying it was saved. `seedChannelRegistry`, `writeChannelConfig` and `writeChannelDefaults` resolve whether they wrote.
