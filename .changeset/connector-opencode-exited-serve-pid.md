---
"@cotal-ai/connector-opencode": patch
---

An OpenCode launch no longer refuses to start because of a recorded server that exits during the liveness check. `ps` also fails for a pid that is gone by the time it runs, and that failure used to read as a server the platform could not inspect, so the launch failed with `agent "<name>" is already running`. The check now probes the pid again after a failed `ps`, and only a pid that is still present keeps the fail-closed answer.
