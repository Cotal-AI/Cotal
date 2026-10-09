---
"@cotal-ai/connector-core": patch
---

A seat no longer shows its session a run turn whose deadline has passed. The seat pulls pending turns every 15 seconds, and a turn it had pulled before its deadline was injected on any frame until the next pull dropped it, even though the run had already failed the step and the manager refuses its yield. Expired turns are now left out of the injected context while the next pull settles them.
