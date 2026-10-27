---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A retiring agent no longer keeps a membership row written after its inventory. Once the delivery daemon is asked for a lifecycle's membership inventory, it refuses that lifecycle's durable joins and leaves, and it reads only after the ones already running have finished. A manager's chat-session and static reconcile retirements now take the same 8 retirement slots as its seats.
