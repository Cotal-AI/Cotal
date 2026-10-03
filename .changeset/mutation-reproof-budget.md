---
---

Mutation reproof now ends inside its own run budget. When a shard's selected fixtures need more time than the step allows, the run stops at the budget, puts back any mutant in flight, names every selected fixture it cut short or never started, and fails as unmeasured. Before, the step was killed from outside with no tally and with the fixtures that never ran unnamed. This changes repository CI tooling only, so no published package is bumped.
