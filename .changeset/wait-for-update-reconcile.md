---
"cotal-ai": patch
---

Retrying a Cotal self-update on Linux waits for the previous update's reconciliation to finish. The retry checks the installed packages only after the recorded child can no longer change them.
