---
"@cotal-ai/tmux": patch
---

A tmux session the runtime creates no longer keeps the shell window tmux opened it with. After `cotal down --with-agents`, the `cotal-<space>` session and its tmux server used to keep running with only that shell. Now the session ends with its last seat. A session that was already there keeps its other windows.
