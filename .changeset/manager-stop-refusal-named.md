---
"@cotal-ai/manager": patch
---

A manager shutdown and a failed resume now report a runtime that refused to stop a seat as `stop failed: <message>` at once. Before, the refusal reached only stderr, and both waited out the exit timeout and then blamed the timeout.
