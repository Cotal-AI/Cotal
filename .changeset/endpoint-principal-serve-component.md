---
"@cotal-ai/core": patch
---

Move the endpoint's principal serve and `prompts` presence internals into an internal component. `servePrincipal`, `setPromptsPresence`, `nextPromptsSeq` and `callPrincipal` stay on the endpoint and behave as before. The package's exports are unchanged.
