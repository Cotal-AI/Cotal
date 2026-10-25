---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The CLI reference now names the codes these refusals give. A run verb given a program file that
does not exist refuses `TARGET_NOT_FOUND`, one this account cannot read `PERMISSION_DENIED`, both
exit 2, and a folder `USAGE_INVALID`, exit 1. `up --server tls://` without a certificate and key
refuses `USAGE_INVALID`, and on a prepared root `UNSUPPORTED`, exit 2.
