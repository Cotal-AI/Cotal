---
"@cotal-ai/core": patch
---

The standing-renewal smoke's expired-credential cell now goes red on every run when the endpoint's expiry guard is removed, and its mutation fixture grades that cell again. The broker still admits a JWT during the second its `exp` names, so a rebuild that dialed inside that second presented the expired credential without a denial and the cell stayed green. The suite now holds its failed renewal read until that second has passed, and the cell counts only the broker's CONNECT denial, no longer the expiry line of a connection that had already authenticated. Endpoint behaviour is unchanged.
