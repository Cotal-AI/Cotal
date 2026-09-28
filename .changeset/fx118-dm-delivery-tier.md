---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
---

A DM send now reports the stored sequence and the recipient's status at send instead of a bare success, and `cotal deliver pending <name>` reads a recipient's held DMs from the broker.
