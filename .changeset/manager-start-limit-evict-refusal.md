---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

The systemd user unit that `cotal service install` writes now sets a start limit (`StartLimitIntervalSec=30min`, `StartLimitBurst=20`), so a manager that cannot start stops after 20 attempts instead of restarting every 20 seconds forever. The manager's restart eviction also stops reporting a delivery daemon that answered and refused as "not reachable on the ctl.delivery-admin rail" with advice to start the daemon. A refusal now carries the daemon's own reason, such as a missing `$SYS` cred and how to re-mint it, and only a rail that cannot be reached is reported as unreachable. A manager that cannot verify eviction of its predecessor still exits 1 with the gate frozen (SPEC 13.1).
