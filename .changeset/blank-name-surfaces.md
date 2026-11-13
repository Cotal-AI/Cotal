---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
"@cotal-ai/manager": patch
"@cotal-ai/pi": patch
"@cotal-ai/web": patch
"@cotal-ai/workspace": patch
---

A participant whose name is blank is shown by its id. This covers `cotal watch`, `who`, `endpoints`, `channel members`, `join`, `chat`, the console, the compose target and palette, the terminal UI, the dashboard badge, the connector roster, orientation and inbox, a Hermes injected turn, the offline notice, the ambiguous-name error and the pending delivery label. A blank name used to print as nothing or as a line break. The same now holds for a pi mention, a once-task spawner, space delete, a DM recipient in chat, the Manager list, a legacy seat, the attach picker, the preserve refusal, teardown, the join receipt, the console agent and confirm lines, a spawn result, an anycast take or DM result, a pane label in the Manager's browser console, and the principals `cotal chat --plain` names for a shared display name.
