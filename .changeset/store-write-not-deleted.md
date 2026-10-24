---
"@cotal-ai/cli": patch
---

A broker that stopped JetStream after a store write it could not make, such as on a store that went read-only, no longer reads as a deleted space. `send` and the other commands that read the space first said its streams were deleted under the running stack and named a restart that creates them again, empty, though every message was kept. They now refuse `DEPENDENCY_UNAVAILABLE` naming the write failure the broker logged. Only a broker that answers that the chat stream is not found shows the space deleted. The repair that `send` and `status` name now follows the cause: a permission denied makes the store writable again instead of freeing disk space.
