---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A FIFO or another file that is not regular, where a state file belongs, no longer makes a command
wait forever. A `preferences.json` like that is refused with `PERMISSION_DENIED`, naming it, by
every command that reads preferences. A `.cotal/channels.json` like that refuses `up` with
`USAGE_INVALID`, and `persona` lists such a catalog file as unreadable and names it, as `persona
show` already refused it.
