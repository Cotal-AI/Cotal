---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

Record a changed answer on a settled run step. `cotal run amend <runId> <stepKey>` files a new answer beside a settled checkpoint's or ask's accepted one, naming the answer it supersedes, and `cotal run journal` lists each amendment under the step in the order the store committed them, so the last one is the current position. Each filing is its own record, so returning to an earlier position is listed too. A settled `ask` now prints the answer it accepted, as a checkpoint does, read from its answer record even when the value is a record with fields named like a checkpoint's result. The pause stays settled and the run keeps the answer it acted on; a second `answer` is still refused. The hosted path is the `amend` form of the manager's `run-answer` command (cluster revision 19), and a spawned seat may amend only an answer recorded under its own name.
