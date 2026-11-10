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
checks hosted custody and waits for hosted Manager readiness to return.
