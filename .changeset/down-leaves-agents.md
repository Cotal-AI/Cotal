---
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
---

Bare `cotal down` and `Manager.stop()` leave managed agents running. The previous reap is `cotal down --with-agents` / `stop({ withAgents: true })`. A live manager that cannot list seats is refused. Leftover seats are printed after a spare down.

Refs #964. A PTY child may still die when the manager process exits and the PTY master closes; that survival is not claimed here.
