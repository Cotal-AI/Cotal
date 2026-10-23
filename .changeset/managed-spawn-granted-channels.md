---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

When the host enrolls a managed agent with other read or post channels than its persona asked for,
as a host that narrows a request to the account's grant does, the spawn receipt now says so on one
line, listing what was granted beside what was asked. `--json` carries both lists as
`acl.requested` and `acl.effective`.
