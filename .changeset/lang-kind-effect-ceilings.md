---
"@cotal-ai/lang": minor
"@cotal-ai/core": minor
"@cotal-ai/runtime": minor
---

Workflow runs can pin separate effect budgets for spawns, turns and other effect kinds.

The optional ceilings record is saved with the run pins, checked on resume and enforced from the journal across restarts. Existing records retain their total-only ceiling. A per-kind refusal names its limit with L4029 before dispatch, without consuming another kind's allowance.
