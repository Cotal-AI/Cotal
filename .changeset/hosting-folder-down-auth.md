---
"@cotal-ai/cli": patch
---

Stop a user-auth stack from its hosting folder without an IdP sign-in, including stacks started with `--no-manager`.
The missing-pidfile lease check uses the folder's signing authority and still refuses to stop a broker under a daemon that renews its lease.
