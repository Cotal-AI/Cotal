---
"@cotal-ai/manager": patch
---

The manager's teardown target now declares the admitted credential renewal that the static terminal drains before it begins. The free, stop and shutdown paths build that target from the agent's fields, so the agent's handle, seed and restart state no longer ride into the detached teardown. Retirement still drains an accepted renewal before it revokes and cleans up the credential family.
