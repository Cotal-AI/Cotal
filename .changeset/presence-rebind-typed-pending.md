---
"@cotal-ai/core": patch
---

A presence-watch rebind now decides whether the bucket is empty from the typed consumer info the bind already reads. It used to reach the pending count through an optional-chained cast over private nats.js fields, so a client release that renamed one of them would have left the count undefined and skipped the empty-bucket handling without any error: a non-registering observer's view went stale again every liveness window, and a registering observer never re-published its own record.
