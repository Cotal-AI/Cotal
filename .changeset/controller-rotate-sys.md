---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A controller stack, the default from `cotal space create` plus `cotal up`, can now renew its `$SYS` credentials. After `cotal down --yes`, `cotal up --rotate-sys` rotates the system account, starts the stack on the rotated configuration, and reports the new generation and expiry in its receipt (`result.rotatedSystemAccount` in JSON). While any member runs, the rotation is refused `LIFECYCLE_BLOCKED` with `cotal down --yes` as the next step, and an open stack refuses it `UNSUPPORTED`. Before, every controller stack refused `--rotate-sys` with "no controller-owned route", so its creds could not be renewed before they expired.
