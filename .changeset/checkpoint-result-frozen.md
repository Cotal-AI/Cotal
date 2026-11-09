---
"@cotal-ai/lang": patch
---

A checkpoint result is frozen like every other effect result, so assigning to one of its fields raises L2031.

The result record was built after the journal froze the raw outcome, which left its own fields writable while its nested value, an argument changed after the call, and a parallel result already refused the write.
