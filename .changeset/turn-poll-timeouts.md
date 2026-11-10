---
"@cotal-ai/runtime": patch
---

Workflow turns survive a transient timeout while waiting for an agent's yield.
Result, deadline and presence reads use bounded timeout and host-starvation retries with
diagnostics naming the read. A turn that fails on a read withdraws its relay before returning, so
the agent cannot later receive a misleading successful yield acknowledgement.
