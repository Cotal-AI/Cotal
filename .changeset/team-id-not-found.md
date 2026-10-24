---
"@cotal-ai/cli": patch
---

A team deployment ID that no record in the root names is refused with `TARGET_NOT_FOUND`, which names
the ID, by `cotal team show` and `cotal team remove`. It was `TARGET_UNAVAILABLE` with a vague Next,
and `team remove <id> --yes` refused it as a route it does not support. `team show` adds that a
deployment ID is 16 hex characters when the value has another shape.
