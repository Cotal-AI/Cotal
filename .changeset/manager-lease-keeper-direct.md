---
"@cotal-ai/manager": patch
---

Remove the manager's lease accessors and its unused per-owner seat count, so manager boot and stop now call the lease keeper directly and smokes read the count from the names-and-capacity part. Exports, commands and wire behaviour are unchanged.
