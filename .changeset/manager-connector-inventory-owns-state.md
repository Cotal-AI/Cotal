---
"@cotal-ai/manager": patch
---

Move the connector rows, the boot notes and the unavailable-connector refresh out of `manager.ts` into the internal connector inventory, which other manager parts now hold and read directly. The package's exports are unchanged.
