---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"cotal-ai": minor
---

Add target-pinned hosted manager retirement and host-issued remote manager authority renewal. Preserve host release ordering, use the existing crash-resumable auth barrier, bound activation to the canonical contract artifacts, bind renewal responses to their exact requests, install every retained credential atomically, and keep remote manager maintenance on fresh host-owned admin authorization without copying host ledger state to participants.

Record request-owned manager issuance rows durably and preserve prior active credentials when issuance fails.
