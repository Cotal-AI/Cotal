---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

A remote manager's serve principal is now formed through `principalKey` everywhere it is compared or written. `@cotal-ai/core` exports `remoteManagerServePrincipal(owner, instanceId)` beside `remoteManagerActors`, and the auth service's manager doors, its manager-service issuer and the manager's registration writer use it (or `principalKey` where the caller already holds the serve actor) in place of a hand-written `<owner>.<serve actor>` join. Those joins did not validate the owner token, so an owner that `principalKey` refuses, such as `u_bad-owner`, could match a gate that named its own hand-joined principal and pass the door's ownership check. That owner is now refused as an invalid owner token. Valid owners form the same principal as before.
