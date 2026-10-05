---
"@cotal-ai/connector-core": patch
---

`cotal_yield` on a turn the run already settled now refuses with the turn id and its deadline. Before, a seat that yielded after its deadline was told "no turn is active" or that it held no such turn. One that yielded between the manager settling the turn and the seat's next poll was told the yield landed, although the run had recorded L4003.
