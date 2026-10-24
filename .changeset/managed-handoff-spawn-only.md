---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Only `cotal spawn` reads `COTAL_MANAGED_HANDOFF_FILE`. Every other command, `--help` and `version` included, drops the variable and leaves the file, where before each one failed with a bare "the managed handoff file does not exist" or silently deleted the file. A file spawn cannot take is refused `USAGE_INVALID`, naming the variable and the path, with `unset COTAL_MANAGED_HANDOFF_FILE` as Next, and under `--json` as an envelope.
