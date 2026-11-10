---
"@cotal-ai/cli": patch
---

Keep broker logs owner-private after rotation on POSIX systems. Broker launches narrow the child umask without changing the caller's mask or unrelated services, so native log rotation cannot create group-readable files.
