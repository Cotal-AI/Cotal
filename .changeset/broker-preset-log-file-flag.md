---
"@cotal-ai/cli": patch
---

`cotal service add <name> --preset broker` works again. A preset option named in camelCase, such as the broker's `logFile`, now takes its dashed flag (`--log-file`, as `cotal up` spells it) instead of refusing the whole preset as UNSUPPORTED.
