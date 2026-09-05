---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

Bound the Jcode connector's pre-join `cotal_orientation` proof so a heavy persona cannot keep a seat alive and unreachable. A turn that overruns the declared three-minute window now exits `readiness_timeout` instead of working with no mesh presence. While that proof is in flight the connector log names `pre-join readiness`, which is not the same as a hang, a missing `--prompt`, or a provider refusal.
