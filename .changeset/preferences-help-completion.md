---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

An invalid `preferences.json` no longer stops `cotal help`, `cotal --help` or `cotal completion`. The docs say such a file stops every command except help and shell completion, but both exited 1 with `SCHEMA_INVALID`, so a person with a broken file could not read the help. Every other command still refuses. The refusal's next step now reads "fix or remove <path>; nothing resets it".
