---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` without `--user-auth` on a stopped root whose space has user-auth state, `--open` included, now refuses as `CONFLICT`, exit 2, before anything is written, and the Next line says to add `--user-auth`. Before, a plain `up` refused only after it had opened the store and claimed the space, and reported the refusal as "Outcome unconfirmed" (`OPERATION_UNKNOWN`, exit 3), as did `up --open`.
