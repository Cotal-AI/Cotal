---
"@cotal-ai/manager": patch
---

Restore named inspection, model-pin audits and helper shutdown for managed static spawn-capable sessions on their holding manager.

Grant only that instance's describe and inspect reads, include them in delegation admission, and keep the same scope on credential renewal. Class-only callers and sibling managers retain their permission refusals.
