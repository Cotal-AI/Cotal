---
"@cotal-ai/manager": patch
"@cotal-ai/core": patch
---

The manager now calls core's `managedRetirementOpId` directly at its eight retirement sites. The private `retireOpId` alias, whose whole body called that function, is gone along with its second copy of the contract. The doc on `managedRetirementOpId` now also says the id is 26 hex characters, so it is itself a lifecycle token. No behavior changes.
