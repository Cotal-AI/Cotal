---
"@cotal-ai/cli": patch
---

Distinguish a local detach from a terminal session ended by the serving side. Preserve the native end reason through attach and managed spawn, restore the terminal before reporting it, and avoid implying the agent is still running or that a stop completed.
