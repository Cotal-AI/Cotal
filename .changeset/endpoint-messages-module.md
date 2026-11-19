---
"@cotal-ai/core": patch
---

Move the endpoint's message authentication against the delivery subject and its history-row checks out of `endpoint.ts` into their own module. The package's exports are unchanged.
