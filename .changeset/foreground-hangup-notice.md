---
"@cotal-ai/cli": patch
---

A closed terminal of a foreground `cotal up` now says the stack is still running and names `cotal down`, then exits 129.

The stack keeps running, as before. The holding process removes its hold record as it exits, and a later `cotal down` removes one a killed holder left behind.
