---
"@cotal-ai/auth": patch
---

`auth grant` and `auth revoke`, and their `actor` spellings, refuse a static or open space with
`UNSUPPORTED` before asking for `--sub`, `--owner` or the ACL flags. Such a space has no actor
ledger, so a subject could never make the grant apply; the refusal used to come only after an
invented `--sub` passed the usage check.
