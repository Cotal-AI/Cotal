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
attempt so an interrupted command cannot poison a later bare shutdown. Managers launched before
process identity pins existed remain stoppable after the documented reduced-guarantee warning:
bare down also warns that sparing cannot be verified, while `--with-agents` uses a one-shot handoff
bound to the manager pid and the live stop-reservation inode, then signals unconditionally.
