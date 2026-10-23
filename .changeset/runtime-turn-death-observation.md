---
"@cotal-ai/runtime": patch
---

Correct the turn API comment: the manager marks a reaped seat's pending turns and carries `agentDownAt` on the deadline terminal. The client's presence watch supplies the early L4002 failure, including while the manager is running.
