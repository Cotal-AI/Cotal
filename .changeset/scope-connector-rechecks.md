---
"@cotal-ai/manager": patch
---

Keep connector binary checks out of the hosted Manager's background stop-policy observer and recheck only the requested application once per launch, model lookup, resume or command listing.
