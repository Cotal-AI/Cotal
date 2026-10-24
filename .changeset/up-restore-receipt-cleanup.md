---
"@cotal-ai/cli": patch
---

`up --restore` now names the restore attempt and the `backup cleanup-fallback` step that retires
it. Its output did not mention the restore, so the attempt id was only in `cotal status`. For a
registry restore, that step in `up --restore` and in `cotal status` now includes
`--discard-history`, which the cleanup requires. When `backup cleanup-fallback` refuses a registry
restore for lacking that flag, it no longer prints the whole `cotal backup` help after the remedy.
