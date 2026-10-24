---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Ctrl-C or `SIGTERM` during `space delete`, `reset store`, `reset space`, `clean store` or `clean all`
now reports what the command left and exits 130 or 143, instead of exiting with no output. The
reset and clean routes release the maintenance lock first. A command that takes over a maintenance
lock left by a process that is no longer running now says so with a `MAINTENANCE_LOCK_TAKEN_OVER`
warning.
