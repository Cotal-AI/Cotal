---
"@cotal-ai/core": patch
---

A durable channel leave refused by a delivery daemon older than 0.166.0 now says the daemon predates lifecycle-aware membership discovery, that the channel stays joined, and that restarting the daemon at this version fixes it. `docs/UPGRADING.md` lists the requirement.
