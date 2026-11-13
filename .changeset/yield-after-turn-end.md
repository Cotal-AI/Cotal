---
"@cotal-ai/connector-core": patch
---

`cotal_yield` for a turn this seat already yielded now says so. Ending a session turn yields `done` for every turn it was shown, so a worker that yields afterwards, for example after a workflow reminder, was told `no active turn "<id>" on this seat`, or `no turn is active` without an id, as if it had never held the turn. It now reads `turn "<id>" was already yielded done by this seat (ending a session turn yields done), so this yield was not recorded`, with or without the id.
