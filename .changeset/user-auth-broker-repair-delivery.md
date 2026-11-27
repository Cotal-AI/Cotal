---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Stop and restart `stack-delivery` ahead of `stack-auth` when `cotal up` repairs a crashed broker in a user-auth stack, keep the stopped-auth refusal ahead of delivery startup when the broker still runs, and update the plane-claim refusal guidance to reflect delivery-first startup.
