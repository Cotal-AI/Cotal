---
"@cotal-ai/tmux": patch
---

Keep a failed tmux session lookup from starting a second server when its socket path contains repeated whitespace.

On Linux, preserve the socket pathname when reading the kernel's Unix-socket table so a moved socket is still recognized as belonging to a live server.
