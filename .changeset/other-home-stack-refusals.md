---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal space create` and `cotal down` for a root whose controller stack runs under another `COTAL_HOME` now refuse `TARGET_UNAVAILABLE` and name the home to run with, like `cotal up`. `space create` used to prepare a space there that could never start, after which `status` reported it as prepared and stopped naming the other home, and `down` refused with a missing member definition and no next step. `status` now names the other home even when this home prepared a space at that root.
