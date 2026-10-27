---
"@cotal-ai/delivery": minor
---

`cotal deliver --spaces` now starts with the spaces it can serve instead of refusing unless every space opens. It names each space it cannot serve with the reason, retries those every 5 seconds, and its ready line names the spaces it retries. One space's fault at a restart no longer keeps every other space's delivery down, nor the plane-claim liveness oracle each lane answers, which an auth service restarting after a crash needs. A space whose lease a single-space daemon still holds opens once that daemon stops. A manifest that does not read or parse whole still refuses startup.

**Breaking:** a supervisor or script that relied on `deliver --spaces` exiting nonzero when one space could not open now sees the host start; read its ready line or its per-space lines for the spaces it retries.
