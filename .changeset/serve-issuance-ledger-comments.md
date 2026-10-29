---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Clarify the endpoint-serve and sibling credential ledger-row comments in `@cotal-ai/core` and `@cotal-ai/manager`: the epoch-pinned serve grant distinguishes a re-registered successor incarnation from its revoked predecessor while a same-second serve re-mint at one epoch idempotently re-stages the active row, and the random `issuance:` tag on `goal-writer` and `session-ledger` gives each sibling issuance distinct bytes even within the same Unix second.
