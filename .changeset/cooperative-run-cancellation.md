---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/runtime": minor
---

Add authenticated cooperative workflow cancellation through the manager endpoint. The original caller can cancel under a live issued generation; signerless hosts also verify interactive owner or admin authority through the issuing host. Replies distinguish the durable revocation marker from an observed local drive outcome, preserve unknown write outcomes and retain the first marker. Read-only status inspection remains available after revocation without permitting new drive or checkpoint-answer authority.

Breaking: embedded RunHostDrive implementations must supply cancel(reason) separately from release(reason). Both language engines and the worker bridge propagate cooperative root cancellation. This does not preempt external tools, stop agent processes or prove resource cleanup. No new CLI or MCP convenience command is added.
