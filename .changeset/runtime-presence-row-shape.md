---
"@cotal-ai/runtime": patch
---

A hosted run's presence reader now keeps only rows whose `card` carries a string `id` and `name`, and skips every other value the way it already skipped bytes that are not JSON. A participant that published `null` under its own presence key used to make every `wait(down(...))`, turn liveness poll, conclave join and worktree-reuse check in that space fail with `L4000` (`Cannot read properties of null (reading 'card')`). Those reads now ignore the row and answer about the agent they watch.
