---
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

A service record folder that this account can read but not write, as the `chmod u+rx` of a read
refusal leaves it, now refuses a write or a held record there, such as `service add` or
`service start`, `PERMISSION_DENIED`, exit 2. The refusal names the folder and only the owner bits the
write lacks, such as `chmod u+w <folder>`, and nothing is written. Before, these ended with an
unconfirmed outcome and the raw permission error on a lock file, with no folder or step. The docs
now say which reads name `chmod u+rx` and which name `chmod u+rwx`.
