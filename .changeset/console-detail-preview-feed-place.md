---
"@cotal-ai/cli": patch
---

Fix two console detail problems. The agent detail's recent traffic cut each preview at a count of UTF-16 units, so a cut inside an emoji showed a replacement character. Previews now cut by terminal columns between whole characters, and a row that would overflow the card ends with `…`, so ASCII previews read as before. Closing a detail also sent the feed back to its newest message at the bottom, so you could not step back through older messages one detail at a time. The feed now keeps its selected message and scroll position across a detail, help and the DM lens. A channel or filter change still jumps to the newest.
