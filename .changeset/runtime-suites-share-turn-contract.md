---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

The manager's `turn` command schemas now live in `@cotal-ai/core` as `TURN_INPUT_SCHEMA` and `TURN_OUTPUT_SCHEMA`. The manager registers them unchanged, so its cluster document and contract digests stay the same. The five runtime suites that serve a manager-shaped `turn` compile the same objects instead of their own copies, which had drifted from the manager's contract and could not notice it changing.
