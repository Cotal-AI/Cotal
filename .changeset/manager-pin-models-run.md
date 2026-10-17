---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

`cotal models` and the hosted `cotal run` verbs take `--on <instance>` to address one manager instance. On a user-auth mesh where an owner runs more than one live manager, the auth service refuses an unpinned manager call, and these commands had no way to name one. `--on` is refused with `cotal run --local`.
