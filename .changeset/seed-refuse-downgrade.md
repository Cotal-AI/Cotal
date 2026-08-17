---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Refuse to stamp the connector seed store down to an older generation. A cotal older than the store's
stamped generation used to miss the fast path, refresh nothing, and then write its own version over
the stamp, leaving the store claiming a generation whose payloads were not the ones installed and
making the next newer command reinstall every connector. It now fails loud before writing anything,
naming both generations and pointing at `cotal ext seed --reset`.
