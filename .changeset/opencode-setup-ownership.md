---
"@cotal-ai/connector-opencode": patch
---

OpenCode 2.x no longer treats a refused plugin setup as completed. A repeated call validates again,
concurrent callers share the setup result, and a completed session releases its setup slot only
after teardown finishes. Later location boots still start no duplicate agent.
