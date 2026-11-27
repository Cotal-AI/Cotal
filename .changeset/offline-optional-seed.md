---
"@cotal-ai/cli": patch
---

A missing optional extension no longer makes an update reinstall every built-in connector or leave a failed seed cursor. `cotal update` reports that one extension and exits non-zero. An ordinary command prints one warning and runs, and the next command installs the extension once the registry answers. `cotal ext remove` can still drop the entry, except while a recovery journal is pending.
