---
"@cotal-ai/cli": patch
---

The broker preset's readiness check sets nats-server's ports report to 0600 before reading it. nats-server writes that report under the umask it inherited, so a group-writable umask left it 0664 in the private launch directory. The change goes through a descriptor that follows no symlink and applies only to a regular file the user owns.
