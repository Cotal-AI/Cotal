---
"@cotal-ai/cli": patch
---

`cotal down` with a flag combination it does not accept, such as `--preserve-state --dry-run`, `--preserve-state --with-agents`, `--store-dir` without `--preserve-state`, or `--file` with `--space`, now refuses as a usage error with `USAGE_INVALID`, exit 1, and stops nothing. So does `--session-store` naming a path that cannot be read or is not a directory. `cotal down --preserve-state` in a folder with no recorded stack refuses with `TARGET_NOT_FOUND`, exit 2, and with `TARGET_AMBIGUOUS` when the folder has more than one. Each used to report `Outcome unconfirmed` with `OPERATION_UNKNOWN`, exit 3, although nothing had run.
