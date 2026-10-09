---
"@cotal-ai/lang": patch
---

A `conclave` now asks the host's stop before it opens, as every other effect does. A run whose driver has asked it to stop (an operator pause or a passed work horizon) is released (L5012) at the next conclave instead of opening it, and a program made only of conclaves no longer runs to completion after the stop. A settled conclave still replays under a stop.
