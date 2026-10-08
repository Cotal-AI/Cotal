---
"@cotal-ai/lang": patch
"@cotal-ai/manager": patch
---

A bridged run whose thread sends a message the host's half of the effect bridge does not know, or answers a bind the host never asked, now fails that run instead of throwing from the message port listener. The throw was an uncaught exception, so a package upgraded in place under a live manager ended the whole manager process, and every hosted run on it, the first time a thread started from the new code spoke a message kind the old host did not know. A manager that cannot read a delivery daemon's SecretStore answer now says the daemon was started by another cotal version and names `cotal down delivery` before `cotal up`; it used to blame a daemon older than #1694 and ask for the daemon to be upgraded.
