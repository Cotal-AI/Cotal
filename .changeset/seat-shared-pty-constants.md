---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

The manager's in-process pty runtime now takes its terminal size, attach scrollback and stop grace window from `@cotal-ai/seat`, which exports `DEFAULT_COLS`, `DEFAULT_ROWS`, `SCROLLBACK_ROWS` and `GRACE_MS`. It used to keep its own copies, so a change to the seat's values left in-process seats on the old size and grace while custodian seats moved. The values themselves do not change.
