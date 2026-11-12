---
"@cotal-ai/linear": patch
---

Re-confirm service readiness when a Linear user-auth endpoint swaps onto a renewed bearer token. `serveLinearUserAuth` now listens for `transport` reconnect events in addition to `connection` rebuilds so live in-place bearer swaps report `ready` to the space authority.
