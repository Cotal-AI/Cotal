---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/runtime": minor
"@cotal-ai/connector-core": minor
---

Let a workflow-spawned seat answer an ask or escalated checkpoint addressed to its own incarnation with its baseline credential. `run-answer` is now self-targeted, the manager checks the caller against the pending relay before writing an answer, connector turn text renders the hosted command without `--by`, and that literal command reuses the managed seat's issued caller identity. Other seats, unrelayed checkpoints, other runs, and run start or resume remain refused. Fixes #1877.
