---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Retrying an interrupted self-update waits for the previous update's reconciliation child before reporting that the installation is current.
The current-installation check also refuses while the selected connector prefix has a live npm child, and source checkouts use the same connector closure lock as installed copies.
