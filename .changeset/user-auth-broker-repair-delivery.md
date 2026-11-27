---
"@cotal-ai/cli": patch
---

Stop and restart `stack-delivery` ahead of `stack-auth` when `cotal up` repairs a crashed broker in a user-auth stack, so `stack-auth` can reclaim its plane claim and delivery stays running after repair.
