---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

Native service stop requests, previews and results can carry a preserved-exit binding (the maintenance attempt and inventory digest) for an agent-retaining manager stop. A preserved request requires `withAgents: false`, its receipts are read against the same key list, and the controller accepts `preserved-exit-returned` only for a preserved request and `returned` only for an ordinary one. No command submits a preserved stop yet, and ordinary stops are unchanged.
