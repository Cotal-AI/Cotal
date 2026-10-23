---
"@cotal-ai/cli": patch
---

Every command that takes `--space` refuses an empty value with `USAGE_INVALID`, exit 1, naming the flag, before anything is read or written. An empty `--space`, as from `--space "$S"` with `S` unset, used to fall back to the selected space, so `history clear --space "" --yes` purged it.
