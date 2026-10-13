---
"@cotal-ai/cli": patch
---

`cotal down --preserve-state` now refuses a presence row whose `card.id` differs from the key it was
read under, with `presence record <subject> is malformed`. A participant may write any value under its
own key, so a forged `card.id` naming the manager let a live participant pass the unmanaged-endpoints
check, and one naming a retained seat made the lost-manager finish report that seat as still live.
