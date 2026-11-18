---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Allow plain update retries to recover interrupted global child launches on Linux and macOS.
Global install and reconcile children now wait for their process-group custody to be recorded before changing files. Recovery retains live descendants and unverified legacy markers instead of racing them.
