---
"@cotal-ai/lang": minor
---

The effect ceiling now bounds a RUN rather than one walk of it. The interpreter's counter started
at zero on every activation, so a run pinned to a small ceiling got a fresh allowance after each
crash or release and a runaway loop of effects never reached its bound. The journal records every
dispatch, so the count is recovered from it when a run resumes.

The step budget is deliberately not changed: interpreter steps are not recorded, there is nothing
to recover a count from, and a replay re-walks the program. Its message and its declaration now say
that it bounds one walk, so the next reader does not assume the two pins are symmetric.
