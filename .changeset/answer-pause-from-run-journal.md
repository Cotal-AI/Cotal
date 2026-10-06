---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

The issuing host no longer signs an answering run operator for a checkpoint token a participant manager names. The manager's request now names the run and step it answers (`operator.answers: { runId, stepKey, amend? }`), and the host requires that run admitted on the manager's instance, reads the pause's token off the run's journal under a read it mints for that run, and requires a served answer to name the same run and step as the request it observed. Before, a manager could be issued the answer and settle writes for another instance's waiting pause. The pause lookups `openCheckpointToken`, `settledPauseToken`, `stepPauseToken`, `CheckpointNotOpen` and `CheckpointNotAmendable` move to `@cotal-ai/lang`; `@cotal-ai/runtime` still exports the first four. A participant manager and its issuing host must upgrade together.
