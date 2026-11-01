---
"@cotal-ai/manager": patch
---

A manager shutting down after a failed preservation cut no longer waits out the exit timeout for a seat whose hard stop threw, and reports that seat's refused stop once instead of adding a second "did not exit" entry.
