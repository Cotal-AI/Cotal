---
"cotal-ai": patch
"@cotal-ai/seat": patch
---

Daemon uninstall waits through a macOS peer disconnect during shutdown.

The bounded shutdown check reobserves a connection closed before its kernel identity could be read. It still requires the daemon process and endpoint to be gone before removing the recorded installation.
