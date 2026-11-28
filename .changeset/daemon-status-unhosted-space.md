---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal daemon status --space <name>` now exits 2 when the background service does not host that Manager, with a next step for the space or `DEPENDENCY_UNAVAILABLE` with the path and recovery advice if a local record could not be read.
