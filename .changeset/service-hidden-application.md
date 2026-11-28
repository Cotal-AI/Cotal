---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal status` and `cotal setup` now say when an application this shell can run is one the background service reports missing, and name `cotal daemon setup` while that command can refresh this installation. They read that from the service's own cached status, the first frame of the existing status watch, which does not probe or refresh. With no such report, no unexpired local sign-in, more than one sign-in, an expired sign-in, no recorded unit, a service this installation does not hold, a relative PATH entry, an unfinished service repair, or a local setup destination, the line stays as it was.
