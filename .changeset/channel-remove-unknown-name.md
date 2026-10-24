---
"@cotal-ai/cli": patch
---

`cotal channel remove` now refuses a name with no saved entry and no retained messages with `TARGET_NOT_FOUND` (exit 2), before the confirmation and before any purge, and lists the registered channels. A name that differs from a registered channel only in case names the registered spelling. Before, `channel remove nosuch --purge --yes` or `channel remove General --purge --yes` for a space holding `#general` reported `Nothing removed` with 0 messages purged and exit 0, so a typo read as done. A channel with retained messages and no saved entry is still a `no-op`, and `--purge` still deletes its messages.
