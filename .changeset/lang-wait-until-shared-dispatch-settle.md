---
"@cotal-ai/lang": patch
---

A `waitUntil` whose observe throws now settles its entry through the same code as every other effect whose handler throws. The refusal settle and the whole failed-dispatch record (the cancelled settle, the carried language code, the recorded detail, the stack and the clock advance) were written out a second time in `waitUntil`, so a rule changed in one copy could leave waits recording handler faults differently from the rest. Behaviour is unchanged.
