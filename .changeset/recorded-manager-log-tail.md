---
"@cotal-ai/cli": patch
---

Manager log tails now report `TARGET_NOT_FOUND` when the captured log is missing. Both `cotal manager logs` and `cotal service logs stack-manager` name the missing file and still return an empty tail for an existing empty log.
