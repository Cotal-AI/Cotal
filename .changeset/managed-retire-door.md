---
"@cotal-ai/auth": minor
---

Add a loopback door, `POST /managed-lifecycle/retire` (`MANAGED_RETIRE_PATH`), that lets a host finish a managed agent's terminal retirement when the remote manager that should request it is gone. It carries the interactive door's guards, requires the managed grant to be revoked at that lifecycle first, and runs the rail's `managedRetirementOpId(uid)` operation. The rail and the door share one in-process flight, so they never execute the same retirement twice.
