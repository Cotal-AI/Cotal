---
"@cotal-ai/cli": patch
---

Report a killed manager as absent immediately when its status service does not answer.
An unexpired lease no longer changes a stale local PID record to not-serving, so the component exit code stays consistent before and after lease expiry.
