---
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

A logged-in user's workflow run on a `cotal supervise` participant manager can spawn, turn and despawn agents that user owns and receive their typed answers. The run's spawn takes the admin reach of the user who started the run, read from that user's actor-ledger row when the spawn runs, so a space that requires the event plane no longer refuses it and a revoked login demotes it. The host pins each run mediator it signs for a participant manager to a placement on that manager's own instance, so a program may place a spawn there; a placement on any other instance is refused at `run start`.
