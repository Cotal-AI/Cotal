---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

The broker record and the user-auth pidfile template each have one name. `@cotal-ai/workspace` exports `NATS_PIDFILE`, and `cotal up`, the nats descriptor, `cotal status`, the broker service, the controller-stack checks and the `clean` sweep all take the broker record from it. The sweep takes the user-auth record from `AUTH_PIDFILE`. Renaming either constant moves every site that writes or reads that record.
