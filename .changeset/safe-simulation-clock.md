---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Workflow simulation rejects clock settings that cannot keep millisecond precision. Use whole milliseconds for `clock.start`; the simulator reports when a wake time, deadline or elapsed time exceeds JavaScript's safe integer range.
