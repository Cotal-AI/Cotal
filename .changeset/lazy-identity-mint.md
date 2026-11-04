---
"@cotal-ai/workspace": minor
---

`createManagerInstanceIdentity` and `createAuthInstanceIdentity` take a `mint` callback instead of a proposed identity. The callback runs only when no record exists, so a restart or a losing concurrent start no longer builds a lifecycle uid and a serve nkey to throw away.
