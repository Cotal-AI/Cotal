---
"@cotal-ai/auth": patch
---

The auth package's option types now take the data account as `ServiceKeys["dataAccount"]` instead of restating `{ pub: string; signingSeed: string }` in thirteen places, so a change to what the auth service holds of the data account reaches every declaration that receives it. No runtime change.
