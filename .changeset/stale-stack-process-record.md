---
"@cotal-ai/cli": patch
---

On a controller stack, a crashed member's process record whose pid another process now holds no longer blocks `cotal down` or `cotal down stack-broker`. A record whose process is gone, or whose pid runs another start than its identity pin records, is stale: `down --dry-run` names it, and a complete `down` removes it with its pin and says so in a `STALE_PROCESS_RECORD` warning, without signalling the process that holds the pid. A record that may still front a live process still refuses, and the refusal now names each record's path and pid, with a Next that says what to check.
