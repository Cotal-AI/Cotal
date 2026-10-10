---
"@cotal-ai/connector-core": patch
---

The connector's capacity limits now say what they bound. The inbox size, the overflow-evicted classification memory, the focus exclusion limit and the protected-disposition limit carry doc comments naming the structures each one caps, including that the focus limit bounds the exclusion list and the id-less copy tally separately. The in-flight hold ceiling, which was an unnamed twice-the-inbox expression, is now its own constant derived from the inbox size, and the endpoint notice log's cap of 16 is a named constant. No values or behavior change.
