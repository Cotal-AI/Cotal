---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Hosts can release a workflow before a selected live effect kind without failing the run.
The driver exposes `beforeEffect(kind)` beside `PauseToken`, and both engines ask it after replay lookup but before counting, journaling, or dispatching live work. Language and worker hosts receive the same kind through `shouldStop(kind)`. A later same-pin resume can permit the next effect without reauthorizing the recorded prefix.
