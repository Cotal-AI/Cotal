---
"@cotal-ai/auth": minor
---

Ordinary and managed user-auth callers now receive exact-lifecycle endpoint caller rows from native caller policy. Controlled owner grants to managed actors capture their actual current parent lifecycle and covering immutable grants. The callout checks current approval, root, name, assignment and ancestor policy, uses core's native row builders, and rechecks authority after signing and native-key recording. Revocation denies new issuance without claiming terminal connection removal. Applications still need service-host approval and the asserted payload prerequisite. Native control endpoints retain their existing authority contracts.
