---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Run a manual registration's policy refresh where the policy is consumed. The refresh reached the
pinned exchange from the command dispatcher, ahead of every command's own refusals, so `cotal status`
on a pre-policy manual entry failed on a transport error and `cotal supervise` reported that error
instead of its `--server` mismatch or missing-login sentence. Spawn, join and supervise now refresh
after their local refusals; read-only commands never refresh. The bundle validator, the pinned fetch
and the dial classifier move to `@cotal-ai/workspace` so the manager can share them.
