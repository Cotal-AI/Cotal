---
"@cotal-ai/auth": patch
---

`issueRemoteManagerAuthority` now maps each manager-service authority operation to its required credentials through a frozen `Record` keyed by the core operations tuple, replacing the nested ternary and its unreachable default arm.
