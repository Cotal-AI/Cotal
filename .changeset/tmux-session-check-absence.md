---
"@cotal-ai/tmux": patch
---

The tmux runtime creates a session only when tmux says none is reachable. `ensureSession` used to read every failed `has-session` as absence, so a query that failed for another reason, such as a moved socket, started a second server beside the one holding the seats. It now treats as absence only tmux's own reports: the session is not on the server, no server is running, or nothing is bound at the socket path tmux would use. A live server whose socket file was moved still shows in the kernel's bind table and makes the spawn refuse with tmux's diagnostic; a never-used path on a fresh host still gets its first server.
