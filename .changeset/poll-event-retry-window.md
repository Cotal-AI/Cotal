---
"@cotal-ai/connector-core": patch
---

Make the event retry smoke test confirm that the broker has forgotten a frozen message id before checking recovery after duplicate-window expiry.
