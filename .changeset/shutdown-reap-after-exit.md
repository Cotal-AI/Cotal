---
"@cotal-ai/manager": patch
---

A manager shutdown that stops its seats now logs a seat's `seat reaped:` line only after the runtime proves that seat exited. A seat whose stop the runtime refused, or whose exit was not proved within the stop timeout, used to be logged as reaped by the same shutdown that then failed naming it, so `manager.log` could not say which seats were gone. Such a seat is now named only by the shutdown error.
