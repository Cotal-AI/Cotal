---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Add an optional guest-root PTY composition that delivers managed material by value to one non-root child and uses cgroup-v2 emptiness for descendant exit proof. Refuse unsupported confinement and preserve the ordinary workstation default. Forward a foreground CLI's graceful SIGTERM to its owned harness and wait for cleanup.
