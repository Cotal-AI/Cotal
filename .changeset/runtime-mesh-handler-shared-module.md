---
"@cotal-ai/runtime": patch
---

Move the constants and helpers that the mesh handler shares with its components (poll and deadline bounds, the seat and agent-handle readings, the permit and supervise readers and `CheckpointAnswerMissing`) out of `mesh-handler.ts` into an internal `mesh-handler-shared.ts`, so the components no longer import the handler at runtime. The package surface is unchanged.
