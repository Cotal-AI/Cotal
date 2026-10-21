---
"@cotal-ai/cli": patch
---

`cotal up --no-manager` on a legacy stack whose manager is live no longer tells you to run `cotal down manager`, which is now a service stop and refuses. The refusal says this stack has no command that stops only its manager, and names the whole-stack route: `cotal down`, then `cotal up --no-manager --space <space>`. The docs that described per-component stops now say which stack kinds have a manager-only stop, and that a legacy stack has none for its manager, delivery daemon or auth service.
