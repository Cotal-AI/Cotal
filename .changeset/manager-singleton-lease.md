---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

fix: one manager per space via a singleton lease

A manager now acquires an atomic per-space KV lease at startup (mirroring the delivery daemon's
single-flight lease) and refuses to start if another already holds it. `spawn -f` reads that lease to
reuse the running manager — failing loud on a checkout-root or runtime mismatch — instead of deciding
from the local `.cotal/manager.pid`, which was blind to a manager started another way and would start a
second supervisor. Two managers on one space queue-split control requests, causing partial spawns and
"no agent" teardowns; the lease makes that structurally impossible.
