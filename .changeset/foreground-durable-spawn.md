---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

Foreground `cotal spawn` now provisions the full durable footprint (read-ACL row included), so a foreground agent gets the delivery daemon's durable backstop instead of silently running live-only and permanently losing every channel message posted while its connection blips. `--live-only` restores the old behavior explicitly. A foreground exit now also retires the agent's creds and broker footprint, mirroring the manager's despawn.
