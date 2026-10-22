---
"cotal-ai": patch
---

Add `cotal daemon service-connect`, `service-disconnect` and `service-status` on Linux. The running daemon connects to a space as its own approved service, using the stock service renewal, and reports `connected` only when the broker accepted the connection and the space accepted it as ready. Approval pending, a refusal, an unreachable space and a revocation are each reported as not connected. The connection renews and reconnects on its own, and stopping the daemon closes it.
