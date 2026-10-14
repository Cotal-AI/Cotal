---
"@cotal-ai/connector-opencode": patch
---

On OpenCode 2.x, a peer batch is acked only by the end of an execution that started after the batch was submitted. An end observed while idle, a replay of one, or an end positioned before the running execution started no longer acks a newly submitted batch, and a failed prompt submission no longer lets a second batch into an execution that is still running.
