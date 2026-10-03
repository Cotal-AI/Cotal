---
"@cotal-ai/seat": patch
"@cotal-ai/connector-core": patch
---

Record the two accepted residuals of the seat reap in the security model. The reap kills the seat child's process group by membership with no per-member start identity check, and it trusts the pids and start tokens its custody record names, so a same-uid process that rewrites `record.json` chooses what the next reap signals. The `reapSeat` doc comment and the design note on signer isolation no longer claim that the reap signals only identity-matched pids.
