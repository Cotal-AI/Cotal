---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The manager's `spawn`, `despawn`, `stop`, `inspect` and `cancel` schemas now live in `@cotal-ai/core` beside the `turn` pair, and the manager serves them from there. The runtime suites that stand in for a manager serve the same objects, so a change to the manager's contract now reaches them. Before, each suite carried its own copy, and those copies accepted a blank `model`, `role`, `variant` or `agent` on `spawn` that the manager refuses. The served contracts are unchanged.
