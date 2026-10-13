---
"@cotal-ai/connector-opencode": patch
---

On OpenCode 2.x, a message that arrives while a turn runs now goes out as the next turn as soon as that turn succeeds, fails or is interrupted. The adapter used to buffer it and wait for an unrelated arrival to wake the seat, so a role request could outlive its ack wait and be handed to another holder of the role. A boot prompt held back by a running turn goes out at the turn end the same way. A failed turn's own batch is not resubmitted at once, so a turn that keeps failing does not loop.
