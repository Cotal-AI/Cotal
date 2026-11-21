---
"@cotal-ai/manager": patch
---

Move the connector rows, the boot notes and the Claude wake recheck into the manager's internal connector inventory, so each has one owner instead of being read through getter and setter callbacks on `Manager`. The package exports, commands and wire behaviour are unchanged.
