---
"@cotal-ai/workspace": patch
---

A multi-space host no longer acknowledges a manifest that drops a space while that space's open is still running past the pass deadline. Since the bounded lane opens of 0.115.2 such an open sat outside the lane map, so `<manifest>.applied` named the manifest at once; the open then settled, the host took the lane, and only the next pass closed it, so a writer that fences on the acknowledgment before tearing a space down could see a lane come up after it was told there was none. The host now holds the record until that open has settled and any lane it produced is closed, the same way it already holds it for a lane whose close did not confirm, and names the space it is holding for. Spaces the manifest still names are unaffected, and the other spaces keep opening and serving while one removal is held. A late open that fails releases the hold at once instead of waiting out the reopen interval.
