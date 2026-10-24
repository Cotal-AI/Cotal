---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A revoked workflow run no longer takes an answer. `cotal run answer`, hosted or `--local`, refuses an open checkpoint or `ask` of a revoked run with `LIFECYCLE_BLOCKED`, naming who revoked it and why, and files nothing, so the run stays parked instead of completing. A revocation marker that cannot be read refuses the answer the same way. `cotal run show` still lists the open request, says that it takes no answer, and no longer offers the answer command. SPEC §14.8 states the rule.
