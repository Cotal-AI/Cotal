---
"@cotal-ai/manager": patch
---

A manager shutdown logs `seat reaped` for a seat only after the runtime proves that seat exited. A seat whose stop was refused, or whose exit was not proved, is named by the shutdown error and has no reap line.
