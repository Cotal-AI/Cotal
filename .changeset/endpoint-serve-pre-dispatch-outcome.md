---
"@cotal-ai/core": patch
---

An endpoint now marks every refusal it raises before running the command with `outcome: not-executed`, as SPEC 13.3 requires. Before, only the bind fence, the unmapped-target refusal and the args-schema refusal said so, and a wrong envelope version, sender, operation, contract digest or target mode, a missing deadline, a refused target or authority check, or a body that is not JSON came back with no outcome, which a caller has to read as `unknown`. The serve loop now decides the outcome from whether it has dispatched to the handler, so a check added ahead of the handler is covered too. A refusal the command itself raises is unchanged. A refusal too large to publish, which comes back as `resource-exhausted`, now keeps the outcome it stated instead of dropping it.
