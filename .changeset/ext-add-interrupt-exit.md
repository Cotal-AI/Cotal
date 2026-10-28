---
"@cotal-ai/cli": patch
---

`cotal ext add` interrupted by SIGINT or SIGTERM rolls the install back, releases its mutation lock from the one cleanup path, and exits 130 or 143. It used to call `process.exit(130)` from inside the install, after that path had already released the lock itself, so the cleanup existed twice and SIGTERM exited as SIGINT. A refused add still exits 1. The success line is printed only once the prefix has committed.
