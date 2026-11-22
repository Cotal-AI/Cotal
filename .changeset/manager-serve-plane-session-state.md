---
"@cotal-ai/manager": patch
---

Move the manager's session plane state (the session plane, the session-ledger connection, identity and credential, and the session-key renewal timer) from the Manager into the serve plane that creates it, which credential renewal and terminal input now read directly instead of through per-field accessors. Exports, commands and wire behaviour are unchanged.
