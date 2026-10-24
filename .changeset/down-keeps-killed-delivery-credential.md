---
"@cotal-ai/cli": patch
---

A `cotal down` that had to kill a stack's delivery member keeps the delivery credential, as it does for a delivery daemon that was already gone. The killed daemon never released its lease, so the next `cotal up` now recognises the row and waits it out. It used to mint a new credential, meet the dead daemon's live lease and fail `OPERATION_PARTIAL`.
