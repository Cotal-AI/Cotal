---
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
---

Plain login refreshes a Manager service when a parent directory is group-writable only by your private group and has no extended ACL. If `getfacl` is missing, the skip names `chmod g-w` or installing `acl`.
