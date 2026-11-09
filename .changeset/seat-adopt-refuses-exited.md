---
"@cotal-ai/seat": patch
---

Adopting a seat whose custodian recorded its child's exit, or whose custodian process is gone, now throws instead of returning a handle that reports the seat running for ever; a seat client rejects a request whose write fails instead of throwing out of the process.
