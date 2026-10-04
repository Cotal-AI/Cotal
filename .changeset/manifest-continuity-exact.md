---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manifest agent can declare `continuity: exact` to come back in its previous harness session. The manager records the session the connector proves on the first launch, reopens it on every later launch, and refuses one recorded for another space, connector or directory. Preflight refuses `exact` on a connector that cannot reopen an exact session.
