---
"@cotal-ai/auth": patch
---

`handleManagerServiceAuthority` now takes `ManagerServiceAuthorityCtx`, exported from `@cotal-ai/auth`, which holds only the fields the handler and its dispatcher read. A host that serves the manager-authority route with a context it builds itself no longer casts that context to the full private handler context, so a dispatcher arm missing from it is now a compile error. It used to typecheck and then fail with `is not a function` on the first request of that kind.
