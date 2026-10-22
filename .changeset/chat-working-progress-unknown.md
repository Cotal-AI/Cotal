---
"@cotal-ai/cli": patch
---

`cotal chat` and `cotal watch` now show a working peer as "working · progress unknown": chat in its `/who` roster and recipient picker, watch in its roster table. `cotal who`, `cotal ps` and the console already did. A `working` presence says the seat claims to be busy, not that its work is advancing, and neither view observes the peer's last reply to say more.
