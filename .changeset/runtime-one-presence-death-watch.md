---
"@cotal-ai/runtime": patch
---

`wait(down)` and `turn` now read an agent's death through one shared presence watch. Each used to carry its own copy of the read, the incomplete-scan retry, the superseded or lapsed split, the lapse window and the manager check, so a change to the rule had to be made twice and a change that reached only one copy stayed green in the suite that covers the other. The two effects keep their own deadline, cancellation and reaction to a death. Behavior is unchanged.
