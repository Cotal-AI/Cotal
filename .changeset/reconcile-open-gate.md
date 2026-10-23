---
"@cotal-ai/manager": patch
---

`cotal manager reconcile` on a healthy stack now says the gate is open and there is nothing to repair,
and its Next says nothing needs doing unless you meant another gate. It used to point at the delivery
liveness oracle. A missing gate reads the same way. The code and exit code are unchanged.
