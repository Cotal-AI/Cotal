---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Add `cotal daemon serve` and `cotal daemon status` on Linux. `serve` runs the local machine daemon in the foreground and serves an owner-only status endpoint at `$XDG_RUNTIME_DIR/cotal/daemon.sock`. `status` reads its state, version, process ID and uptime over that endpoint. The daemon refuses a directory or socket it does not own with the exact mode, never removes an existing entry at the socket path, and drops connections from other users. A socket left by a killed daemon makes the next `serve` refuse with `CONFLICT` and a manual recovery. This release does not sign in, start a Manager or install a system service.
