---
"@cotal-ai/core": patch
---

Launch watchers wait and clean up temporary files even when an agent's `PATH` omits system utilities. The watcher uses the system's standard utility path and leaves the agent's `PATH` unchanged.
