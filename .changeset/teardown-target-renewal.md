---
"@cotal-ai/manager": patch
---

The manager's teardown chain now declares an agent's admitted credential renewal on its teardown target, and the free, stop and shutdown paths build that target from the agent's fields instead of spreading the whole agent record into the teardown. The static terminal still drains the renewal before it begins, and retirement behavior is unchanged.
