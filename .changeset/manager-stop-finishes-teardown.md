---
"@cotal-ai/manager": patch
---

Finish manager shutdown when a managed agent cannot be proven stopped. The manager still closes its broker connections and console listener and exits with code 1, where it used to stay running with its connections open and ignore every later SIGINT or SIGTERM.
