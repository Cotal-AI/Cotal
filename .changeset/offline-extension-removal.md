---
"@cotal-ai/cli": patch
---

Extensions can be removed offline without npm fetching peers for packages that stay installed. Removal and failed-add cleanup now use the same peer policy as installation.
