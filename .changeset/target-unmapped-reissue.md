---
"@cotal-ai/core": patch
---

A targeted manager call that reaches a manager not hosting its target is now repaired instead of refused. Each manager resolves targets against the agents it runs, so in a space with two managers the class queue could hand a named `cotal_despawn` of a live agent to the sibling, which refused it as `expired` with no outcome, the same reply a retired agent gets. The refusal now carries `outcome: not-executed` and a `ai.cotal.ep.target-unmapped` detail saying that manager holds no mapping for the target, and an unpinned call re-describes and re-issues it within the existing split-repair bound. An agent that no manager hosts still ends in the `expired` refusal once that bound runs out, and a pinned call gets the refusal of the instance it named.
