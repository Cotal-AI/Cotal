---
"@cotal-ai/workspace": patch
---

The raw off-registry preflight (`--creds`, or `--server` with an unregistered `--space`) re-probes at the same 8s confirm budget the registry preflight uses before refusing, so a live broker on a slow link connects instead of being reported as not running, and the timeout sentence names a budget that was spent (#709).
