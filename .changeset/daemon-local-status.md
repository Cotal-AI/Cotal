---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Add `cotal daemon serve` and `cotal daemon status` on Linux. `serve` runs the local machine daemon in the foreground and serves an owner-only status endpoint at `$XDG_RUNTIME_DIR/cotal/daemon.sock`. `status` reads its state, version, process ID and uptime over that endpoint. Both commands refuse a runtime directory that is not owned by the current user or is not mode 0700. The status client also checks socket ownership and mode 0600. The server never removes a pre-existing socket-path entry and drops connections from other users. A socket left by a killed daemon makes the next `serve` refuse with `CONFLICT` and a manual recovery. This release does not sign in, start a Manager or install a system service.
