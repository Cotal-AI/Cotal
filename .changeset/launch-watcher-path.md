---
"@cotal-ai/core": patch
---

Launch watchers wait and clean up temporary files even on systems where `sleep` and `rm` are unavailable. The watcher uses the launcher's Node executable and leaves the agent's `PATH` unchanged.
