---
"@cotal-ai/connector-jcode": patch
---

The jcode connector now owns the full private-instance shutdown path instead of trusting mutable
SDK registry PIDs. Each launch carries a random launch-bound identity and captures immutable process
start tokens before teardown; a PID from `servers.json` or `active_pids` is signalled only when it
matches that launch, so stale records can never kill an unrelated process tree. Shutdown stops the
bridge first, waits through a bounded quiescence window for late daemon records, and then tears down
the exact recorded or already-captured launch processes before the host returns.
