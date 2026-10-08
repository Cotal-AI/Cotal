---
"@cotal-ai/auth": minor
---

Remove `allowManagerAuthority` from the exchange policy that `handleManagerServiceAuthority` takes. Both exchange faces set it to `true`, so its refusal could never fire, and the route table alone decides which face serves `POST /manager-service-authority`. The docs and source comments now list that route on the public listener, which has always served it. A policy object literal that sets `allowManagerAuthority` no longer compiles, and a JavaScript caller that set it to `false` is no longer refused by the handler; see the upgrading guide.
