---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A full restore of a backup made before the state it replaced was preserved now says that it left
out the chat and DM history and workflow runs written after the backup, and keeps their only copy.
Its receipt warns with `NEWER_HISTORY_NOT_RESTORED` and names the store it set aside. The
`backup cleanup-fallback` preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`, and
`backup cleanup-fallback` and `clean restore-fallback` delete that store only with
`--discard-history`, as they do after a registry restore.
