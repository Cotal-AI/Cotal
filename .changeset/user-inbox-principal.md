---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

On a per-user-auth mesh, a client now names its connection and reply inbox `<owner>-<actor>-<nonce>` from its own bearer, and the auth callout grants the reply inbox only under that bearer's owner and actor, on the ordinary and service-endpoint arms alike. The callout refuses any other connection name, and refuses a bare inbox nonce with a message naming 0.167.0 as the minimum client version. Upgrade clients before the auth service; a 0.167.0 client also connects to an older auth service. `bearerInboxConnId`, `userInboxConnId`, `assertUserInboxConnId` and `USER_INBOX_MIN_CLIENT_VERSION` are exported from `@cotal-ai/core`, and `decodeBearerPrincipal` is now exported.
