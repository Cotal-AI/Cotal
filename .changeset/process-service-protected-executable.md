---
"@cotal-ai/cli": patch
---

A process service's executable now follows the rule for other local writers that project roots,
credential files and preset paths already follow. `cotal service add` refuses an executable that
another account could replace, or one in a folder another account could write. `start`, `restart`
and an installed unit refuse it the same way before anything launches. The refusal is
`PERMISSION_DENIED` and names each unsafe path and the `chmod` that fixes it.
