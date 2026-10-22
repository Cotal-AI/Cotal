---
"cotal-ai": patch
---

Add `cotal daemon register --space <s>` on Linux. The running daemon requests its own service registration with a space through the space's stock service authority, signed in as this machine, and reports the answer: `approval-required`, `pending` or `registered`. Registration is not activation or serving, so the machine is not connected yet. The request ID is saved before the first send and replayed unchanged on every later call, including after a restart. A space without service endpoints, and every other readiness failure from `connect-check`, refuses without sending anything. A refusal by the space owner is reported with the space's reason. The daemon never approves itself, binds its own name, or touches a Manager.
