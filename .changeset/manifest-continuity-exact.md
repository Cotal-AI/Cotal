---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/pi": patch
---

A manifest agent can declare `continuity: exact` to come back in its previous harness session. The manager records the session the connector proves over its authenticated control endpoint on the first launch, keeps that record current through crash recovery, preserved resume and stop, reopens it on every later launch and preserved resume under the same proof, and refuses one recorded for another space, connector or directory. A reopen fails when the harness no longer has the session rather than starting an empty one under the same id: connectors declare the new `supportsSessionReopen` capability and honor `LaunchOpts.reopenSession`, and Pi reopens with `--session`. Preflight refuses `exact` on a connector that cannot reopen an existing session.
