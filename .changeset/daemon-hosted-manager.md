---
"cotal-ai": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

Daemon setup makes a computer ready to launch agents from its space.
The machine daemon supervises a stock Manager per space, resumes it after restart, and reports
launch-readiness separately from machine-service approval. Setup re-probes the pinned Manager on
reruns and reports its identity at `manager.instanceId`, while top-level `instanceId` remains the
machine-service registration. Use `--no-manager` for connection-only setup; `--wait` requires it.
Hosted status includes observation time, exit and stop diagnostics, and bounded private rotating logs.
Setup restarts a mismatched daemon through its recorded native service. Installed npm replacement
verifies the new entry before releasing the daemon to its recorded supervisor. `cotal update`
checks hosted custody and waits for hosted Manager readiness to return. Self-update also reloads
a mismatched default daemon from the same installation when it hosts no Managers.
Setup and update never restart a service pinned to another installation. Setup reuses compatible
hosting operations or names both installations and the reinstall choices. Update reports the
other daemon's installation and version after reconciling its own installation.
Update reports and skips hosted records without a live child, and gives a disconnect remedy for
live custody that cannot be confirmed. Native restart failures retain their cause and name
`cotal daemon start`; a failed rollback no longer hides the primary failure.
Update keeps its ordinary continuity checks when Linux has no runtime directory for a daemon.
New native jobs mark their launch, and generation activation verifies that marker against the
recorded same-install source before exiting for the supervisor.
Setup reports unsupported machine-service registration with the same state as service status and
preserves the provider session check in its sign-in step.
Setup requires an available connector in the hosted Manager's fresh status before reporting launch-ready,
and allows time for daemon reconciliation before Manager readiness.
Setup validates usage without installing or reconciling connector packages in the invoking shell.
The daemon reconciles stock connectors in its own environment before hosting and prepares the
default persona in the Manager's own catalog. A bare npm upgrade prepares idle Managers and
restarts first. The new daemon refuses stale connectors with a repair command and backed-off
retry, so the old generation never reopens launches after a partial shared-store reconciliation.
Uninstall removes only per-space hosting records and works with the default daemon home's lock file.
Corrupt hosting records refuse only their space and setup repairs them after readiness succeeds.
Periodic liveness uses the parent IPC channel without auth callouts and never restarts for the
daemon's own authority outage. Fresh pinned status probes withdraw stale readiness. Child recovery
requires repeated IPC misses and an empty-seat preservation fence. Stopped status retains the
Manager identity and observation, and daemon sign-in refusals consistently name daemon login.
Pending upgrades count seats without fencing admission, back off activation attempts, and show the
installed version and waiting cause in status. Foreground daemons stay running after replacement.
Endpoint limit refusals stop parsing immediately and allow already accepted finite replies a bounded
flush before closing the connection.
