---
"@cotal-ai/tmux": patch
---

The tmux driver's session check creates the first server, and throws instead of starting a second server when a server is still listening but its socket was moved.
