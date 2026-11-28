---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal status` and `cotal setup` now say when an application this shell can run is one the background service reports missing, and name `cotal daemon setup`. They read that from the service's own cached status, the first frame of the existing status watch, which does not probe or refresh. With no such report, a signed-out account, a service this installation does not hold, or a local setup destination, the line stays as it was.
