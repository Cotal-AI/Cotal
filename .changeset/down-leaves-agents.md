---
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
---

Bare `cotal down` and `Manager.stop()` leave managed agents running. The previous reap is `cotal down --with-agents` / `stop({ withAgents: true })`. Spare down always signals; listing seats is honesty, not a refuse-to-signal. Listing an unreachable manager must not prune the mesh registry. `--with-agents --dry-run` prints the seats that would be reaped. `--with-agents` that cannot list seats still stops the stack, reaps none, and exits non-zero. A spared agent's runtime handle cannot be released: `AgentHandle` has no close or unref, and the detached set the manager moves spared agents into is not readable, so `stop({ withAgents: true })` cannot reap what a plain `stop()` spared. The CLI is unaffected because it force-exits on shutdown; an embedder that spares agents and then returns normally will not exit while those children live. Tracked in #1377.

Refs #964. A PTY child may still die when the manager process exits and the PTY master closes. A successor manager on the same root may still adopt leftover seats; that path is not claimed here. `cotal down` is the listing surface; a failed `cotal up` teardown SIGTERMs the manager without a seat snapshot. An older manager whose `stop()` still reaps will still reap on SIGTERM.
