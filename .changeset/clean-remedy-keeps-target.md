---
"@cotal-ai/cli": patch
---

`cotal clean` without `--force` now prints a command that keeps the flags picking what is deleted: `--store-dir` for `store` and `all`, and `--space`, `--server`, `--creds` and `--dms` for `history`. The command it printed for `clean store --store-dir <dir>` used to drop `--store-dir`, so following it deleted the default store and left the one the user named.
