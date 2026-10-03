---
"@cotal-ai/manager": patch
---

A spawn or resume refused at the manager's seat limit now states what holds the slots and whether waiting can free one, for example `at capacity (50 of 50 slots: 49 managed, 0 reserved, 1 cooling); waiting frees a cooling slot in 7s, or despawn one`. It quoted only the fixed limit, so an operator could not tell a cooling slot that frees in seconds from seats that never free on their own. The gate also counted a launching seat twice, once as a reservation and once as a managed seat, so it refused below the limit: with 49 seats in `cotal ps`, one of them still joining, a spawn was refused at 50. Each seat now counts once, and the managed count is the number `cotal ps` lists for that manager.
