---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

Bound the Jcode connector's pre-join `cotal_orientation` proof so a heavy persona cannot keep a seat alive and unreachable. A turn that overruns the declared three-minute window now exits `readiness_timeout` instead of working with no mesh presence. That teardown kills the private Jcode tree and discards the in-flight turn; nothing from it is recovered. The connector log still names the gate while the proof is running, and a later outcome line names what happened: proved (with or without a spawn `--prompt`), provider refusal, or timeout. A hang that never returns and never hits the bound has no outcome line.
