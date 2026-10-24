---
"@cotal-ai/cli": patch
---

`clean restore-attempt` and `clean restore-fallback` without `--force` now name the command to run with its `--attempt`, and a repeated `clean restore-fallback` refuses with `TARGET_NOT_FOUND`, saying the restore has settled and naming `cotal status`, instead of a bare "maintenance journal does not exist".
