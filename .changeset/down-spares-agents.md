---
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/seat": minor
---

Make bare `cotal down` and `Manager.stop()` spare managed agents by default. Use
`cotal down --with-agents` or `Manager.stop({ withAgents: true })` for deliberate destructive
teardown. Linux PTY seats release manager-local proxy custody while their detached custodians and
child processes continue running, and the CLI binds destructive intent to the exact live stop
attempt so an interrupted command cannot poison a later bare shutdown.
