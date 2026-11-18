---
"@cotal-ai/workspace": patch
---

A stopped space whose project folder was deleted no longer sends the user to that folder. `status` says the folder no longer exists instead of naming `cotal up` there, and `send` and `history` refuse `TARGET_UNAVAILABLE` instead of reporting a missing seed. Both name moving the folder back or `cotal space forget <space>`. Run with `--space` from the folder it was renamed to, `send` and `history` give the moved-folder refusal they give there without `--space`.
