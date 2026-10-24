---
"@cotal-ai/cli": patch
---

A Ctrl-C during `service start`'s readiness wait now names the instance it left running and the
commands that finish it, and `service status` and `cotal status` show that start as interrupted
instead of starting.
