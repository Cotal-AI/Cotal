---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

A failed workflow run now records why it failed. The run driver writes the error's language code, when it has one, and its message (bounded to 4000 characters) on the failed run status as `failure`. `cotal run ps` and `cotal run show` print the state as `failed (<code>)`, the run view prints the message under `Failure`, and the JSON status and `ps` rows carry `failure`. Before, a thrown error, an L4010 null access, an L4013 step budget or an L4023 deadline showed only "failed", and the cause was only in the manager's log. SPEC §13.7 adds the optional field.
