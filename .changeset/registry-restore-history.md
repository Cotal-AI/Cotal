---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A registry-only restore no longer leads to deleting the only copy of the history it left out. The restore journal now records the restore's selection. For a registry restore, `backup cleanup-fallback` refuses with `USAGE_INVALID` and deletes nothing unless `--discard-history` is given, and its `--dry-run` warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`. `backup restore --only registry`, or a restore of a registry-only artifact, adds a `HISTORY_NOT_RESTORED` warning saying that chat and DM history start empty, and its result names the `previousStore` that holds the only copy of that history. `up --restore --restore-only registry` prints the same two lines. The receipt's Next says that deleting that store needs `--discard-history`.
