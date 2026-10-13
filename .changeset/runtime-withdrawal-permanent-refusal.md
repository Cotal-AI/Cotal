---
"@cotal-ai/runtime": patch
---

A cancelled `turn`, `ask` or escalation whose relay withdrawal is refused for a reason a retry cannot change now fails its step at once with that refusal's code. Before this, every refusal was retried silently every two seconds until the relay's deadline, so a cancelled step against a manager that serves no `cancel` (`not-found`), or an accepting manager with no such relay pending (`failed-precondition`), stayed in its scope for the step's whole timeout. Only `unavailable` and `deadline-exceeded` are still retried until the deadline. A withdrawal the accepting manager refuses is now thrown as an `EpEnvelopeError` carrying its code.
