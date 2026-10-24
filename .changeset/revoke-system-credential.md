---
"@cotal-ai/cli": patch
---

`auth revoke-credential` given one of the stack's own system-account credentials, such as
`connection-evictor.creds` or `membership-observer.creds`, now refuses `UNSUPPORTED` and says the
space's system account issued it. Its Next is `cotal down --yes`, then `cotal up --rotate-sys`,
which retires that account's credentials, and it says that full backups taken before then no longer
restore. Before, it refused `CONFLICT` as a credential from another account and told you to run it
for the space that issued it, which was this space.
