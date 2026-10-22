---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A controller stack whose manager stop has no terminal receipt can be unblocked. When a manager is killed before it answers a stop request, every later bare `up` and `down` refused `LIFECYCLE_BLOCKED` and no command cleared it. `cotal down --abandon-stop <request-id> --yes` now abandons that request once the manager and the `down` that sent it have both exited: it removes the request, the stop reservation and any `--with-agents` shutdown intent that stop armed, records the manager `failed`, and stops the rest of the stack with a `STOP_ABANDONED` warning, because whether the manager stopped its agents' seats is not confirmed. The refusal's remedy names the command with its request ID.
