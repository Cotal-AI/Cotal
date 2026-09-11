---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

Wire `--max-sessions` from the CLI into the manager's live-session ceiling.

`ManagerOptions.maxSessions` was documented as deployment-configurable, but nothing in the CLI
could set it, so every live manager sat at 64. `cotal supervise --max-sessions` and
`cotal up --max-sessions` now parse a positive integer, pass it into the manager, and record it on
the mesh so a same-root repair, resume, or `spawn -f` that restarts the manager does not silently
drop a raised ceiling. A refresh of an already-running manager refuses a different `--max-sessions`
rather than recording an unapplied setting. A capacity refusal names `--max-sessions`. Default
remains 64. Size for agents × panes: the browser console opens one session per pane.
