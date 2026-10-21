---
"@cotal-ai/cli": patch
---

`cotal down` with a flag combination it does not accept, such as `--preserve-state --dry-run`, `--preserve-state --with-agents`, `--store-dir` without `--preserve-state`, or `--file` with `--space`, now refuses as a usage error with `USAGE_INVALID`, exit 1, and stops nothing. It used to report `Outcome unconfirmed` with `OPERATION_UNKNOWN`, exit 3, although nothing had run.
