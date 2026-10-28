---
"@cotal-ai/connector-core": patch
---

`packUnits` refuses a unit that cannot fit in one frame as a unit. The message names the byte sizes, the event count and the run, and no longer calls the unit a source observation cut mid-record. A close hands the same function a terminal the emitter authored, which consumes no source record, and that refusal was telling the operator to look for a record the close never read. The reason a unit is never split stays in the function's doc comment.
