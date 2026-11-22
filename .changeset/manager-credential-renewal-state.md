---
"@cotal-ai/manager": patch
---

Move the manager's credential-renewal state (the daemon renewal ownership flags, the endpoint-serve renewal timer, the secret store identity, the remote standing credentials and their renewal and adoption promises, the renewal debt, and the credential push bookkeeping) from the Manager into the credential-renewal part, which the broker transport, boot and serve plane now read directly instead of through per-field accessors. Exports, commands and wire behaviour are unchanged.
