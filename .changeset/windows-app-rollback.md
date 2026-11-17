---
"cotal-ai": patch
---

A Windows app update that does not start its background service restores the previous app and says why, including on the welcome screen.

Readiness checks run in a child process that exits before rollback removes the replacement runtime, releasing its native modules first.
