---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-claude-code": patch
---

The OpenCode connector keeps the batch a turn carries in one place, `SurfacedBatch` in `plugin.ts`, which both the 1.x and the 2.x adapters drive, so what a turn's end acks and what it leaves to redeliver has one definition. On 2.x a native prompt typed while a batch's turn was open carried that batch again together with everything queued behind it, and the end of the open turn then acked the queued messages too, though that turn was never submitted with them. It now carries nothing while a batch is open, as 1.x does, and the queued messages go out as their own turn once the open one ends. A comment in the Claude Code connector that named the old helper is updated.
