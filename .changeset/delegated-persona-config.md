---
"@cotal-ai/manager": minor
---

Managers using a delegated runtime now refuse caller-supplied persona `config` overrides before looking up or reading the requested host path. `resolve-agent` and `spawn` return the same `failed-precondition` message for every path shape. Direct `Manager.startAgent` calls share the refusal. Select a named catalog persona instead. Locally executing managers and validated resolved-manifest resources retain their behavior.

This changes a previously accepted launch option and ships as a pre-1.0 minor release. Upgrade the Manager to apply the guard. No auth-service change is required.
