---
"@cotal-ai/cli": patch
---

`reset store` and `reset space` on a stopped controller stack now leave an empty store directory and record it in the stack journal. `status` no longer exits 4 with a missing-store warning after a reset, including after `space forget`, and `down` and the next `up` no longer warn `STORE_MISSING`. A store removed by hand still warns.
