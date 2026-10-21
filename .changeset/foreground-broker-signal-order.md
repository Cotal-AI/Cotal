---
"@cotal-ai/cli": patch
---

Keep a foreground broker outside the terminal's interrupt process group on POSIX. Ctrl-C now reaches the CLI owner first, so it can finish the guarded manager and delivery shutdown before signalling the broker.
