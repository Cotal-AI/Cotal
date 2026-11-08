---
"@cotal-ai/tmux": patch
---

The tmux driver's session check now treats a session as absent only when tmux reports that the session does not exist or that no server is running, and throws on any other failure instead of starting a second server.
