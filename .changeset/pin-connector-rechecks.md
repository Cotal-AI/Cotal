---
"@cotal-ai/manager": patch
---

Keep connector executable paths pinned across availability rechecks instead of switching to another copy on `PATH`, name any replacement copy now on `PATH` so operators know to restart the Manager, recheck connector binaries in batch `resume-preserved` launches and supervised crash restarts, include `--on` guidance on instance-pinned wire launch refusals, and keep class spawn subscriptions aligned across closed or redialing serve connections.
