---
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

`createManagerInstanceIdentity` and `createAuthInstanceIdentity` take a function that returns the identity, and call it only when the root has no record. A caller that already holds an identity passes it back from that function. The manager and the auth service no longer read the record themselves before asking for one.
