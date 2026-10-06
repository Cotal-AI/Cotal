---
"@cotal-ai/core": patch
---

A completing registration reopen now decides whether to keep or advance the instance's `processEpoch` from the issuance gate alone: the epoch advances once the gate has committed a registration (`registrationRevision` above 0). The normal path used to ask the records store whether the spec key had any entry, while a resumed registration asked the gate, so the two could commit different epochs for the same history if either store were rebuilt. On histories the shipped paths produce, both answers are unchanged.
