---
"@cotal-ai/auth": patch
---

The auth service now records a manager-caller connection's credential expiry in the issued evidence it writes for that connection's generation. After the credential expires, the generation no longer resolves and is refused with `generation <id> expired at <exp> (SPEC 13.15)`. A run admitted while the generation was live keeps its admission and keeps renewing.
