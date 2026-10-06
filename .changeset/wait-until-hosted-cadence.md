---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

A `waitUntil` whose first observation is not terminal now waits out its cadence on a host that checks journal authority (a manager-hosted run, or `cotal run start --local`) and fails `L4023` at its deadline. Before, its second observation failed `L4000`: the interpreter sent the observation index as the effect's attempt, which the run authority refused, and the authority listed no pause token for a `waitUntil` cadence. Which pause tokens a step owns is now one table that the run authority, the adoption re-arm and a cancelled branch's discharge all read, so a cancelled `waitUntil` on a hosted run also releases its open cadence pause.
