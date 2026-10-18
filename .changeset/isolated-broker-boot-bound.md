---
"@cotal-ai/cli": patch
---

`cotal backup create`, restore and quarantine now fail after 15 seconds when their isolated bootstrap broker stays alive but never accepts connections. The reachability wait recomputed its bound on every pass, so only the 30-minute operation deadline ended it.
