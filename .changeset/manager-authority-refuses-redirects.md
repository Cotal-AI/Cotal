---
"@cotal-ai/auth": patch
---

The manager-service authority request now refuses a redirect, as the other manager-authority requests already did. Before this, a 307 or 308 from the pinned endpoint re-sent the login proof to the address it named and returned that host's answer as the manager's authority material. All remote manager-authority requests now go through one endpoint lookup and one request path, so the redirect refusal and the refusal messages are the same for each of them.
